export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { readState, isPidAlive, readProgress, readRecentLog } from '../state'

export async function GET() {
  const state = readState()
  const running = !!(state.pid && isPidAlive(state.pid))

  return NextResponse.json({
    running,
    startedAt: state.startedAt,
    results: readProgress(),
    recentLog: readRecentLog(),
  })
}
