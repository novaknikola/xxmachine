export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

import { NextRequest } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

const SCRIPT = path.join(process.cwd(), 'scripts', 'open-browser.mjs')

function sse(event: object) {
  return `data: ${JSON.stringify(event)}\n\n`
}

function stateFilePath(accountId: string) {
  return path.join(os.tmpdir(), `xmachine-ob-${accountId}.json`)
}

function readState(accountId: string) {
  try { return JSON.parse(fs.readFileSync(stateFilePath(accountId), 'utf8')) }
  catch { return { active: false, error: null, done: false } }
}

async function runBrowserForAccount(
  accountId: string,
  send: (ev: object) => void
): Promise<'connected' | 'error' | 'timeout'> {
  const stateFile = stateFilePath(accountId)
  fs.writeFileSync(stateFile, JSON.stringify({ active: true, error: null, done: false }))

  send({ type: 'opening', accountId })

  return new Promise((resolve) => {
    const proc = spawn('node', [SCRIPT, accountId, stateFile, '--no-proxy'], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout?.on('data', (d: Buffer) => process.stdout.write('[bulk-browser] ' + d))
    proc.stderr?.on('data', (d: Buffer) => process.stderr.write('[bulk-browser] ' + d))

    const heartbeat = setInterval(() => {
      send({ type: 'waiting', accountId })
    }, 5000)

    const timer = setTimeout(() => {
      clearInterval(heartbeat)
      proc.kill('SIGTERM')
      send({ type: 'error', accountId, message: 'Timeout (10 min)' })
      resolve('timeout')
    }, 10 * 60 * 1000)

    proc.on('exit', () => {
      clearInterval(heartbeat)
      clearTimeout(timer)
      const state = readState(accountId)
      if (state.done) {
        send({ type: 'connected', accountId })
        resolve('connected')
      } else {
        send({ type: 'error', accountId, message: state.error ?? 'Browser closed without login' })
        resolve('error')
      }
    })
  })
}

export async function POST(req: NextRequest) {
  const { accountIds }: { accountIds: string[] } = await req.json()

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: object) => controller.enqueue(encoder.encode(sse(ev)))

      let connected = 0, failed = 0

      send({ type: 'start', total: accountIds.length })

      for (const accountId of accountIds) {
        const result = await runBrowserForAccount(accountId, send)
        if (result === 'connected') connected++
        else failed++
      }

      send({ type: 'done', connected, failed })
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
