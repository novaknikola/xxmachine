export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { STATE_FILE, LOG_FILE, PROGRESS_FILE, readState, isPidAlive } from '../state'

const SCRIPT = path.join(process.cwd(), 'scripts', 'sync-accounts-from-sheet.ts')
// Direct binary path, not `npx tsx` — npx's own resolution goes through a
// shell PATH lookup that may not match what's available to a process spawned
// from inside the already-running pm2-managed Node process (untested here
// since deploy is on hold; this sidesteps the uncertainty rather than
// assuming npx resolves the same way it does over an interactive SSH shell).
const TSX_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'tsx')

/**
 * Spawns scripts/sync-accounts-from-sheet.ts as a detached background
 * process — the same script this whole pipeline has been driven by
 * manually over SSH all day, now reachable from the dashboard instead.
 *
 * detached:true + unref() deliberately, unlike this repo's other
 * spawn-a-script routes (open-browser): those are short-lived, this one
 * runs for potentially hours (dozens of accounts, deliberately slow human-
 * scale pacing between each). Tying it to the Next.js process's lifetime
 * would mean any deploy's pm2 reload silently kills an in-progress run —
 * tracked by PID in a state file instead, so status survives a restart.
 */
export async function POST() {
  const state = readState()
  if (state.pid && isPidAlive(state.pid)) {
    return NextResponse.json({ error: 'A sync is already running', pid: state.pid }, { status: 409 })
  }

  const logFd = fs.openSync(LOG_FILE, 'a')
  const child = spawn(TSX_BIN, [SCRIPT], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  fs.closeSync(logFd)
  child.unref()

  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }))
  // Fresh run — stale results from a previous run shouldn't look like this one's.
  fs.rmSync(PROGRESS_FILE, { force: true })

  return NextResponse.json({ started: true, pid: child.pid })
}
