// ─── Fanvue Integration Types ─────────────────────────────────

export interface FanvueCreator {
  uuid: string
  handle: string
  displayName: string
  nickname: string | null
  avatarUrl: string
  registeredAt: string
  role: string
}

export interface FanvueChat {
  uuid: string
  fanUuid: string
  fanDisplayName: string
  fanHandle: string
  fanAvatarUrl: string
  lastMessage: string | null
  lastMessageAt: string | null
  unreadCount: number
  totalSpend: number
}

export interface FanvueMessage {
  uuid: string
  text: string
  senderUuid: string
  createdAt: string
  isCreator: boolean
}

export type FanPriority = 'low' | 'medium' | 'high' | 'whale'
export type FanStatus = 'active' | 'idle' | 'churned' | 'new'

// ─── Fan Assignment (stored in xmachine, not Fanvue) ──────────

export interface FanAssignment {
  id: string                  // local id
  fanUuid: string             // Fanvue user UUID
  fanName: string
  fanAvatarUrl: string
  creatorUuid: string         // which model/creator
  creatorName: string
  chatterId: string           // xmachine user id
  chatterName: string
  priority: FanPriority
  status: FanStatus
  totalSpend: number
  notes: string
  assignedAt: string
  lastMessageAt: string | null
}

// ─── Chatter Performance (tracked per shift/day) ──────────────

export interface ChatterStats {
  chatterId: string
  chatterName: string
  date: string                // YYYY-MM-DD
  messagessent: number
  fansHandled: number
  revenueGenerated: number    // from Fanvue earnings delta
  responseTimeAvgSec: number
  shiftMinutes: number
}
