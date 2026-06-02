export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

const SCRIPT = path.join(process.cwd(), 'scripts', 'open-browser.mjs')
const STATE_FILE = path.join(os.tmpdir(), 'xmachine-open-browser.json')

let browserProc: ChildProcess | null = null

function readState(): { active: boolean; error: string | null; done: boolean } {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { active: false, error: null, done: false }
  }
}

function killBrowser() {
  if (browserProc) {
    browserProc.kill('SIGTERM')
    browserProc = null
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const proxyUrl: string = body.proxyUrl ?? ''
  const accountId: string = UUID_RE.test(body.accountId ?? '') ? body.accountId : ''

  killBrowser()
  fs.writeFileSync(STATE_FILE, JSON.stringify({ active: true, error: null, done: false }))

  // Account mode: pass accountId as first arg → auto-fills credentials, saves session to correct account
  // Manual mode: pass proxyUrl as first arg → matches account by username after login
  const scriptFirstArg = accountId || proxyUrl

  browserProc = spawn('node', [SCRIPT, scriptFirstArg, STATE_FILE, '--no-proxy'], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  browserProc.stdout?.on('data', (d: Buffer) => process.stdout.write('[open-browser] ' + d))
  browserProc.stderr?.on('data', (d: Buffer) => process.stderr.write('[open-browser] ' + d))

  browserProc.on('exit', () => {
    browserProc = null
  })

  return NextResponse.json({ ok: true })
}

export async function DELETE() {
  killBrowser()
  fs.writeFileSync(STATE_FILE, JSON.stringify({ active: false, error: null, done: false }))
  return NextResponse.json({ ok: true })
}

export async function GET() {
  const state = readState()
  // If process died but state still says active, correct it
  if (state.active && !browserProc) {
    state.active = false
  }
  return NextResponse.json(state)
}
