export type UserRole = 'admin' | 'chatter'

export interface User {
  id: string
  email: string
  name: string
  role: UserRole
  password: string
  createdAt: string
  active: boolean
}

export interface Character {
  id: string
  name: string
  loraUrl: string
  loraScale: number
  basePromptStyle: string
  story: string
  startDate: string
  defaultMode: 'SFW' | 'NSFW'
  telegramChannelId?: string
}

export type ScheduledPostStatus =
  | 'pending_approval'
  | 'approved'
  | 'published'
  | 'rejected'
  | 'failed'

export interface ScheduledPost {
  id: string
  characterId: string
  characterName: string
  imageUrls: string[]
  caption: string
  platforms: ('telegram' | 'fanvue')[]
  scheduledAt: string          // ISO timestamp
  status: ScheduledPostStatus
  telegramMessageId?: number   // bot preview message in admin group
  createdBy: string
  createdAt: string
  publishedAt?: string
  error?: string
}

export type GenerationStatus = 'idle' | 'processing' | 'done' | 'error'

export type GenerationKind = 'text2img' | 'wan_edit'

export interface GenerationRow {
  id: string
  kind: GenerationKind
  characterId: string
  characterName: string
  prompt: string
  dimension: string
  batch: number
  status: GenerationStatus
  outputUrls: string[]
  inputImageUrl?: string
  createdAt: string
  userId: string
}

export type CalendarStatus = 'empty' | 'partial' | 'full'

export interface CalendarDay {
  id: string
  characterId: string
  characterName: string
  date: string
  notes: string
  topic: string
  keywords: string
  description: string
  fanvueDescription: string
  prompts: Record<string, string>
  status: CalendarStatus
  createdAt: string
}

export const DIMENSIONS: Record<string, string> = {
  '1:1': '1024*1024',
  '4:3': '1152*864',
  '3:4': '864*1152',
  '16:9': '1344*756',
  '9:16': '756*1344',
  '2:3': '768*1152',
  '3:2': '1152*768',
}

export interface PromptType {
  id: string
  label: string
  group: 'angle' | 'context' | 'activity'
  hint: string
  instruction: string
}

export const PROMPT_TYPES: PromptType[] = [
  {
    id: 'front_selfie',
    label: 'Front camera selfie',
    group: 'angle',
    hint: 'She holds the phone, candid framing',
    instruction:
      'Front camera selfie — she is holding the phone, slightly imperfect framing, candid natural expression, shot on iPhone front camera.',
  },
  {
    id: 'mirror_selfie',
    label: 'Full body mirror selfie',
    group: 'angle',
    hint: 'Bedroom or bathroom mirror, phone visible',
    instruction:
      'Full body mirror selfie — she holds the phone, reflection visible in the mirror, bedroom or bathroom setting.',
  },
  {
    id: 'pov',
    label: 'POV shot',
    group: 'angle',
    hint: 'What she sees from her own eyes',
    instruction:
      'POV shot — from HER point of view, showing what she sees (her hands, food in front of her, scenery, outfit details). She is not visible in the frame.',
  },
  {
    id: 'closeup',
    label: 'Close-up selfie',
    group: 'angle',
    hint: 'Face close to camera, intimate feel',
    instruction:
      'Close-up front camera selfie — face close to camera, natural lighting, intimate feel, soft expression.',
  },
  {
    id: 'self_timer',
    label: 'Self-timer photo',
    group: 'angle',
    hint: 'Phone propped up, candid pose',
    instruction:
      'Self-timer photo — phone placed on a surface or propped up, she is unaware of the exact moment, candid pose.',
  },
  {
    id: 'bed_morning',
    label: 'Bed / lazy morning selfie',
    group: 'context',
    hint: 'Lying in bed, soft messy look',
    instruction:
      'Lazy morning selfie in bed — she is lying down, slightly messy hair, soft natural light through the window, holding the phone above her face.',
  },
  {
    id: 'outfit_flatlay',
    label: 'Outfit flat-lay POV',
    group: 'context',
    hint: 'Phone overhead shooting clothes',
    instruction:
      'Flat-lay overhead POV of her outfit laid out on the bed or floor — phone held directly above, only her hand or arm partly visible, clothes and accessories arranged.',
  },
  {
    id: 'car_mirror',
    label: 'Car / elevator mirror',
    group: 'context',
    hint: 'Tight space mirror selfie',
    instruction:
      'Mirror selfie inside a car, elevator, or changing room — confined space, phone visible in reflection, casual outfit check vibe.',
  },
  {
    id: 'drink_face',
    label: 'Drink + part of face',
    group: 'context',
    hint: 'Coffee/drink with half-visible face',
    instruction:
      'Selfie with a drink (coffee, smoothie, cocktail) held near her face — only part of her face visible, drink in foreground, cafe or bar setting.',
  },
  {
    id: 'spa_pov',
    label: 'Bathroom / spa POV',
    group: 'context',
    hint: 'Towel, water, legs from her view',
    instruction:
      'POV shot from a spa or bathroom — looking down at her legs in a bathtub, pool edge, or sauna bench. Towel, water, soft lighting. She is not facing the camera.',
  },
  {
    id: 'muay_thai',
    label: 'Muay Thai training',
    group: 'activity',
    hint: 'Boxing gloves, gym mirror, sweat',
    instruction:
      'Muay Thai training — selfie or mirror selfie at the muay thai gym wearing gloves and shorts, gym mirror visible, sweat, focused expression. She holds the phone or props it on the bench.',
  },
  {
    id: 'gym',
    label: 'Gym training',
    group: 'activity',
    hint: 'Gym mirror, athletic outfit',
    instruction:
      'Gym training selfie — full-body mirror selfie at the gym in matching athletic set, weights or machines in background, slightly flushed cheeks, phone visible in reflection.',
  },
  {
    id: 'outdoor_training',
    label: 'Outdoor training',
    group: 'activity',
    hint: 'Park run, beach run, yoga outdoors',
    instruction:
      'Outdoor training — selfie during a run in the park, beach jog, or outdoor yoga session. Sport outfit, natural sunlight, casual sweat, phone in hand or propped on a bench.',
  },
  {
    id: 'beach',
    label: 'Beach enjoyment',
    group: 'activity',
    hint: 'Sand, ocean, bikini, towel',
    instruction:
      'At the beach enjoying the day — selfie in bikini with ocean and sand in the background, or POV looking at her legs on a towel and the sea ahead. Wet hair, sun on skin.',
  },
  {
    id: 'nightlife',
    label: 'Night life',
    group: 'activity',
    hint: 'Club, bar, neon lights, dressed up',
    instruction:
      'Night out selfie — at a club, rooftop bar, or restaurant in the evening. Dressed up, soft warm lights, neon or candlelight, phone selfie or bathroom mirror selfie at the venue.',
  },
]

export const PROMPT_TYPE_MAP: Record<string, PromptType> = Object.fromEntries(
  PROMPT_TYPES.map(p => [p.id, p]),
)

// ── FANS ───────────────────────────────────────────────────────

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6 // 0 = Sun (matches Date.getDay())
export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type WeekdayKey = typeof WEEKDAY_KEYS[number]

export type PaydayRule =
  | { kind: 'none' }
  | { kind: 'monthly'; day: number } // 1..31, clamped to month length
  | { kind: 'weekly'; weekday: Weekday }
  | { kind: 'biweekly'; weekday: Weekday; anchor: string } // anchor ISO date (YYYY-MM-DD)

export interface FanImportantDate {
  id: string
  date: string // YYYY-MM-DD
  label: string
  kind: 'birthday' | 'anniversary' | 'vacation' | 'custom'
}

export interface ManualSpendEntry {
  id: string
  date: string // YYYY-MM-DD
  amountCents: number
  note?: string
}

export type FanStatus = 'subscriber' | 'expired' | 'follower' | 'not_contactable'

export interface Fan {
  id: string
  displayName: string
  fanvueHandle?: string
  fanvueUserUuid?: string
  payday: PaydayRule
  weeklySchedule: Partial<Record<WeekdayKey, string>>
  importantDates: FanImportantDate[]
  manualSpendEntries: ManualSpendEntry[]
  notes: string
  tags: string[]
  // Profile fields (manually entered or synced)
  location?: string
  occupation?: string
  age?: number
  // Layer 2 (Fanvue API hydration) — all optional, written by sync
  status?: FanStatus
  lifetimeGrossCents?: number
  maxSinglePaymentCents?: number
  spendingSources?: Record<string, number> // e.g. { subscription: 1500, tips: 300, ppv: 800 } in cents
  lastPurchaseAt?: string
  subscriptionCreatedAt?: string
  subscriptionRenewsAt?: string
  autoRenewalEnabled?: boolean
  isTopSpender?: boolean
  syncedAt?: string
  // AI summary (Gemini, lazy-fetched)
  aiSummary?: AiSummary
  aiSummaryAt?: string
  aiSummaryError?: string
  createdAt: string
}

// Layer 2 only — daily snapshot used to compute spend deltas
export interface FanSpendSnapshot {
  fanId: string
  date: string // YYYY-MM-DD
  lifetimeGrossCents: number
}

// AI-extracted summary derived from raw chat messages (Gemini)
export interface AiSummary {
  paydayPattern?: string | null            // free text: "Every Friday", "1st of month", "Bi-weekly Mon"
  preferences: string[]                    // 3-7 short tags
  mood?: string                            // e.g. "warm/flirty", "cooled off", "frustrated"
  lastOfferResponse?: string               // e.g. "ignored last PPV", "bought $25 PPV", "asked for free"
  conversationTone?: string                // e.g. "playful", "casual", "serious"
  keyFacts: string[]                       // factual notes ("works night shift", "lives in Texas")
  dailyHooks: string[]                     // 3 short opener ideas
  weeklyStrategy?: string                  // 1-2 sentences
}

// Scheduled message via Fanvue mass-of-one trick
export interface ScheduledMessage {
  id: string                               // local uuid
  fanId: string
  fanvueUserUuid: string
  fanDisplayName: string
  text: string
  price?: number                           // PPV price in dollars (Fanvue accepts decimal)
  mediaUuids?: string[]
  scheduledAt: string                      // ISO timestamp
  // Fanvue-side handles
  massMessageUuid?: string                 // returned when scheduled successfully
  customListUuid?: string                  // temp list created for this send
  status: 'pending' | 'sent' | 'cancelled' | 'failed'
  error?: string
  createdAt: string
}

export interface WanEditSuggestion {
  id: string
  category: 'angle' | 'pose' | 'styling'
  label: string
  prompt: string
}

export const WAN_EDIT_SUGGESTIONS: WanEditSuggestion[] = [
  {
    id: 'angle_three_quarter',
    category: 'angle',
    label: 'Three-quarter angle',
    prompt:
      'Rotate the camera to a three-quarter angle of her face and body, keeping the same lighting, outfit and background.',
  },
  {
    id: 'pose_hand_on_hip',
    category: 'pose',
    label: 'Hand on hip',
    prompt:
      'Change her pose so one hand is resting on her hip and her weight shifts to the opposite leg. Keep face, outfit and background the same.',
  },
  {
    id: 'styling_hair_down',
    category: 'styling',
    label: 'Hair down, soft makeup',
    prompt:
      'Restyle her hair to be down and slightly tousled, with softer natural makeup. Keep the rest of the image identical.',
  },
  {
    id: 'angle_low_pov',
    category: 'angle',
    label: 'Low-angle POV',
    prompt:
      'Lower the camera to a slightly upward angle as if shot from waist level, same scene and outfit.',
  },
  {
    id: 'styling_outfit_swap',
    category: 'styling',
    label: 'Casual outfit swap',
    prompt:
      'Replace her outfit with a casual everyday look (oversized white tee, denim shorts) while keeping pose, face and background unchanged.',
  },
]

export type ViralReelStatus = 'viral_detected' | 'approved' | 'cover_analyzed' | 'image_generated' | 'video_created' | 'archived'

export interface ViralReel {
  id: number
  profile: string
  reel_url: string
  views: number
  posted_at: string
  thumbnail_url?: string
  video_url?: string
  gemini_prompt?: string
  generated_image_url?: string
  kling_video_url?: string
  status: ViralReelStatus
  created_at: string
}

export interface TrackedProfile {
  id: number
  username: string
  active: boolean
  created_at: string
}
