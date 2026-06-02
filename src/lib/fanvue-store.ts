import { FanAssignment, ChatterStats } from './fanvue-types'

function get<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch { return fallback }
}

function set<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(key, JSON.stringify(value))
}

// ─── Fan Assignments ──────────────────────────────────────────

export const fanAssignmentStore = {
  getAll(): FanAssignment[] {
    return get<FanAssignment[]>('xm_fan_assignments', [])
  },
  save(items: FanAssignment[]) {
    set('xm_fan_assignments', items)
  },
  assign(assignment: FanAssignment) {
    const all = this.getAll()
    const idx = all.findIndex(a => a.fanUuid === assignment.fanUuid && a.creatorUuid === assignment.creatorUuid)
    if (idx >= 0) all[idx] = assignment
    else all.push(assignment)
    this.save(all)
  },
  unassign(fanUuid: string, creatorUuid: string) {
    this.save(this.getAll().filter(a => !(a.fanUuid === fanUuid && a.creatorUuid === creatorUuid)))
  },
  getByChatter(chatterId: string): FanAssignment[] {
    return this.getAll().filter(a => a.chatterId === chatterId)
  },
  getByCreator(creatorUuid: string): FanAssignment[] {
    return this.getAll().filter(a => a.creatorUuid === creatorUuid)
  },
  getAssignment(fanUuid: string, creatorUuid: string): FanAssignment | undefined {
    return this.getAll().find(a => a.fanUuid === fanUuid && a.creatorUuid === creatorUuid)
  },
}

// ─── Chatter Stats ────────────────────────────────────────────

export const chatterStatsStore = {
  getAll(): ChatterStats[] {
    return get<ChatterStats[]>('xm_chatter_stats', [])
  },
  save(items: ChatterStats[]) {
    set('xm_chatter_stats', items)
  },
  getByChatter(chatterId: string): ChatterStats[] {
    return this.getAll().filter(s => s.chatterId === chatterId)
  },
  upsert(stat: ChatterStats) {
    const all = this.getAll()
    const idx = all.findIndex(s => s.chatterId === stat.chatterId && s.date === stat.date)
    if (idx >= 0) all[idx] = stat
    else all.push(stat)
    this.save(all)
  },
}

// ─── Fanvue token status (client-side flag only) ──────────────

export const fanvueConnectionStore = {
  isConnected(): boolean {
    return get<boolean>('xm_fanvue_connected', false)
  },
  setConnected(val: boolean) {
    set('xm_fanvue_connected', val)
  },
}
