export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { readState, isPidAlive } from '../state'

export async function POST() {
  const state = readState()
  if (!state.pid || !isPidAlive(state.pid)) {
    return NextResponse.json({ error: 'Nothing running' }, { status: 404 })
  }

  // SIGTERM, not SIGKILL — the script has no signal handler, so Node's
  // default behavior (exit) still applies, but this leaves the door open to
  // add a graceful "finish the current account, write its status, then
  // stop" handler later without changing anything here.
  process.kill(state.pid, 'SIGTERM')
  return NextResponse.json({ stopped: true })
}
