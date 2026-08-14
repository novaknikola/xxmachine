import fs from 'fs'

// Shared with scripts/sync-accounts-from-sheet.ts's own PROGRESS_LOG constant —
// same file, so the UI reads exactly what the script itself is writing as it
// runs, whether it was launched from here or manually over SSH.
export const PROGRESS_FILE = '/root/sheet-sync-progress.json'
export const LOG_FILE = '/root/sheet-sync.log'
export const STATE_FILE = '/root/sheet-sync-state.json'

export interface SyncState {
  pid: number | null
  startedAt: string | null
}

export function readState(): SyncState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { pid: null, startedAt: null }
  }
}

/** process.kill with signal 0 only tests existence/permission — doesn't actually kill anything. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function readProgress(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function readRecentLog(maxLines = 60): string[] {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    return lines.slice(-maxLines)
  } catch {
    return []
  }
}
