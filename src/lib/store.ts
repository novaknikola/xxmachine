import { User, Character, GenerationRow, CalendarDay, PROMPT_TYPES, CalendarStatus, Fan, FanSpendSnapshot, ScheduledMessage } from './types'

const TIANA_STORY = `Tiana is European 22 years old girl from United Kingdom, born in London. Studied Media and Design in London, completed masters in Italy. Personality: warm, feminine, confident, playful, emotionally present. Interests: fashion, cooking, fitness/gym, nature, traveling, food & drinks. Small family, wants 3-4 kids in future. Recently moved to Bali after leaving Dubai due to war situation feeling unsafe. Now building her own clothing and lingerie brand - checking fabrics, meeting suppliers. Goes to spa to relax and recover from stress. Builds connection with fans through small daily moments. Focuses on her business and independence. She has big chest and athletic body`

const TIANA_PROMPT = `ultra realistic 4k photo 22 years old European girl, natural lighting, photorealistic, highly detailed skin texture, shot on iPhone, smartphone photography, iPhone camera look, natural lighting, neutral color balance, slightly cool tones, realistic white balance, no cinematic color grading, no warm filter, HDR smartphone processing, subtle contrast, slightly flattened highlights, real-life exposure, casual framing, imperfect composition, candid moment, unposed, everyday realism, slight motion blur, natural dynamic range, no studio lighting`

const DEFAULT_CHARACTERS: Character[] = [
  {
    id: 'tiana',
    name: 'Tiana',
    loraUrl: 'https://huggingface.co/nolea/Z-Image_LoRAs/blob/main/tiana.safetensors',
    loraScale: 0.8,
    basePromptStyle: TIANA_PROMPT,
    story: TIANA_STORY,
    startDate: '2026-05-05',
    defaultMode: 'SFW',
  },
  {
    id: 'diana',
    name: 'Diana',
    loraUrl: 'https://huggingface.co/nolea/Z-Image_LoRAs/blob/main/diana.safetensors',
    loraScale: 0.8,
    basePromptStyle: TIANA_PROMPT,
    story: '',
    startDate: '',
    defaultMode: 'SFW',
  },
  {
    id: 'miyanna',
    name: 'Miyanna',
    loraUrl: '',
    loraScale: 0.8,
    basePromptStyle: TIANA_PROMPT,
    story: '',
    startDate: '',
    defaultMode: 'SFW',
  },
]

const DEFAULT_ADMIN: User = {
  id: 'admin-1',
  email: 'admin@xmachine.ai',
  name: 'Admin',
  role: 'admin',
  password: 'xmachine2026',
  createdAt: new Date().toISOString(),
  active: true,
}

function get<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function set<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(key, JSON.stringify(value))
}

// ── USERS ──────────────────────────────────────────────────────
export const usersStore = {
  getAll(): User[] {
    const users = get<User[]>('xm_users', [])
    if (!users.find(u => u.id === DEFAULT_ADMIN.id)) {
      const all = [DEFAULT_ADMIN, ...users]
      set('xm_users', all)
      return all
    }
    return users
  },
  save(users: User[]) {
    set('xm_users', users)
  },
  add(user: User) {
    const users = this.getAll()
    users.push(user)
    this.save(users)
  },
  update(id: string, data: Partial<User>) {
    const users = this.getAll().map(u => u.id === id ? { ...u, ...data } : u)
    this.save(users)
  },
  delete(id: string) {
    this.save(this.getAll().filter(u => u.id !== id))
  },
  findByEmail(email: string): User | undefined {
    return this.getAll().find(u => u.email.toLowerCase() === email.toLowerCase())
  },
}

// ── CHARACTERS ─────────────────────────────────────────────────
export const charactersStore = {
  getAll(): Character[] {
    const chars = get<Character[]>('xm_characters', [])
    if (!chars.length) {
      set('xm_characters', DEFAULT_CHARACTERS)
      return DEFAULT_CHARACTERS
    }
    return chars
  },
  save(chars: Character[]) {
    set('xm_characters', chars)
  },
  add(char: Character) {
    const chars = this.getAll()
    chars.push(char)
    this.save(chars)
  },
  update(id: string, data: Partial<Character>) {
    this.save(this.getAll().map(c => c.id === id ? { ...c, ...data } : c))
  },
  delete(id: string) {
    this.save(this.getAll().filter(c => c.id !== id))
  },
}

// ── GENERATIONS ────────────────────────────────────────────────
function normalizeGeneration(row: GenerationRow): GenerationRow {
  return { ...row, kind: row.kind ?? 'text2img' }
}

export const generationsStore = {
  getAll(): GenerationRow[] {
    return get<GenerationRow[]>('xm_generations', []).map(normalizeGeneration)
  },
  save(rows: GenerationRow[]) {
    set('xm_generations', rows)
  },
  add(row: GenerationRow) {
    const rows = this.getAll()
    rows.unshift(row)
    // keep last 500
    this.save(rows.slice(0, 500))
  },
  update(id: string, data: Partial<GenerationRow>) {
    this.save(this.getAll().map(r => r.id === id ? { ...r, ...data } : r))
  },
  getByUser(userId: string): GenerationRow[] {
    return this.getAll().filter(r => r.userId === userId)
  },
}

// ── CALENDAR ───────────────────────────────────────────────────
function deriveCalendarStatus(day: CalendarDay): CalendarStatus {
  const hasContext = !!(day.topic || day.description || day.fanvueDescription)
  const promptCount = Object.values(day.prompts ?? {}).filter(v => v && v.trim()).length
  if (!hasContext && promptCount === 0 && !day.notes) return 'empty'
  if (promptCount >= PROMPT_TYPES.length) return 'full'
  return 'partial'
}

function normalizeCalendarDay(day: CalendarDay & { prompts?: unknown }): CalendarDay {
  let prompts: Record<string, string> = {}
  if (Array.isArray(day.prompts)) {
    // migrate legacy 5-prompt arrays into the first 5 prompt-type ids
    const legacyIds = ['front_selfie', 'mirror_selfie', 'pov', 'closeup', 'self_timer']
    day.prompts.forEach((val, i) => {
      const key = legacyIds[i]
      if (key && typeof val === 'string') prompts[key] = val
    })
  } else if (day.prompts && typeof day.prompts === 'object') {
    prompts = day.prompts as Record<string, string>
  }
  const normalized: CalendarDay = {
    ...day,
    notes: day.notes ?? '',
    prompts,
  }
  normalized.status = deriveCalendarStatus(normalized)
  return normalized
}

export const calendarStore = {
  getAll(): CalendarDay[] {
    return get<CalendarDay[]>('xm_calendar', []).map(d => normalizeCalendarDay(d))
  },
  save(days: CalendarDay[]) {
    set('xm_calendar', days)
  },
  upsert(day: CalendarDay) {
    const next = normalizeCalendarDay(day)
    const days = this.getAll()
    const idx = days.findIndex(d => d.id === next.id)
    if (idx >= 0) days[idx] = next
    else days.push(next)
    this.save(days)
  },
  upsertMany(newDays: CalendarDay[]) {
    const days = this.getAll()
    for (const raw of newDays) {
      const day = normalizeCalendarDay(raw)
      const idx = days.findIndex(d => d.id === day.id)
      if (idx >= 0) days[idx] = day
      else days.push(day)
    }
    this.save(days)
  },
  getByCharacter(characterId: string): CalendarDay[] {
    return this.getAll().filter(d => d.characterId === characterId)
  },
  delete(id: string) {
    this.save(this.getAll().filter(d => d.id !== id))
  },
}

// ── FANS ───────────────────────────────────────────────────────
function normalizeFan(raw: Fan & { weeklySchedule?: unknown; importantDates?: unknown; manualSpendEntries?: unknown; tags?: unknown }): Fan {
  return {
    ...raw,
    weeklySchedule: (raw.weeklySchedule && typeof raw.weeklySchedule === 'object')
      ? raw.weeklySchedule as Fan['weeklySchedule']
      : {},
    importantDates: Array.isArray(raw.importantDates) ? raw.importantDates as Fan['importantDates'] : [],
    manualSpendEntries: Array.isArray(raw.manualSpendEntries) ? raw.manualSpendEntries as Fan['manualSpendEntries'] : [],
    tags: Array.isArray(raw.tags) ? raw.tags as string[] : [],
    payday: raw.payday ?? { kind: 'none' },
    notes: raw.notes ?? '',
  }
}

export const fansStore = {
  getAll(): Fan[] {
    return get<Fan[]>('xm_fans', []).map(f => normalizeFan(f))
  },
  save(fans: Fan[]) {
    set('xm_fans', fans)
  },
  add(fan: Fan) {
    const fans = this.getAll()
    fans.unshift(normalizeFan(fan))
    this.save(fans)
  },
  update(id: string, data: Partial<Fan>) {
    this.save(this.getAll().map(f => f.id === id ? normalizeFan({ ...f, ...data }) : f))
  },
  upsert(fan: Fan) {
    const fans = this.getAll()
    const idx = fans.findIndex(f => f.id === fan.id)
    const next = normalizeFan(fan)
    if (idx >= 0) fans[idx] = next
    else fans.unshift(next)
    this.save(fans)
  },
  delete(id: string) {
    this.save(this.getAll().filter(f => f.id !== id))
  },
  getById(id: string): Fan | undefined {
    return this.getAll().find(f => f.id === id)
  },
}

// ── FAN SPEND SNAPSHOTS (daily lifetime totals for delta math) ─
export const fanSnapshotsStore = {
  getAll(): FanSpendSnapshot[] {
    return get<FanSpendSnapshot[]>('xm_fan_snapshots', [])
  },
  save(snapshots: FanSpendSnapshot[]) {
    set('xm_fan_snapshots', snapshots)
  },
  getByFan(fanId: string): FanSpendSnapshot[] {
    return this.getAll()
      .filter(s => s.fanId === fanId)
      .sort((a, b) => a.date.localeCompare(b.date))
  },
  upsert(snapshot: FanSpendSnapshot) {
    const all = this.getAll()
    const idx = all.findIndex(s => s.fanId === snapshot.fanId && s.date === snapshot.date)
    if (idx >= 0) all[idx] = snapshot
    else all.push(snapshot)
    this.save(all)
  },
  upsertMany(snapshots: FanSpendSnapshot[]) {
    const all = this.getAll()
    for (const s of snapshots) {
      const idx = all.findIndex(x => x.fanId === s.fanId && x.date === s.date)
      if (idx >= 0) all[idx] = s
      else all.push(s)
    }
    this.save(all)
  },
}

// ── SCHEDULED MESSAGES (Fanvue mass-of-one) ────────────────────
export const scheduledMessagesStore = {
  getAll(): ScheduledMessage[] {
    return get<ScheduledMessage[]>('xm_scheduled_msgs', [])
  },
  save(items: ScheduledMessage[]) {
    set('xm_scheduled_msgs', items)
  },
  add(item: ScheduledMessage) {
    const items = this.getAll()
    items.unshift(item)
    this.save(items)
  },
  update(id: string, patch: Partial<ScheduledMessage>) {
    this.save(this.getAll().map(i => i.id === id ? { ...i, ...patch } : i))
  },
  remove(id: string) {
    this.save(this.getAll().filter(i => i.id !== id))
  },
  getByFan(fanId: string): ScheduledMessage[] {
    return this.getAll().filter(i => i.fanId === fanId)
  },
}

// ── SESSION ────────────────────────────────────────────────────
export const sessionStore = {
  get(): User | null {
    return get<User | null>('xm_session', null)
  },
  set(user: User) {
    set('xm_session', user)
  },
  clear() {
    if (typeof window !== 'undefined') localStorage.removeItem('xm_session')
  },
}
