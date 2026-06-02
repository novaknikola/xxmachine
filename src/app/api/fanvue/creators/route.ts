import { NextRequest, NextResponse } from 'next/server'
import {
  getAgencyCreators,
  getCreatorChats,
  getCreatorTopSpenders,
  getCreatorEarnings,
  getChatterLeaderboard,
  getTeamMembers,
  sendMessageAsCreator,
  getCreatorMessages,
  getChats,
  getChatMessages,
  sendMessage,
  getCurrentUser,
  getFanInsights,
  isConnected,
} from '@/lib/fanvue'

export async function GET(req: NextRequest) {
  if (!(await isConnected())) {
    return NextResponse.json({ error: 'NOT_CONNECTED' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action')

  try {
    switch (action) {
      case 'status':
        return NextResponse.json({ connected: true })

      case 'me': {
        const data = await getCurrentUser()
        return NextResponse.json(data)
      }

      case 'creators': {
        const data = await getAgencyCreators()
        return NextResponse.json(data)
      }

      // Direct creator endpoints (conected as creator)
      case 'chats': {
        const filter = searchParams.get('filter') ?? undefined
        const data = await getChats(filter)
        return NextResponse.json(data)
      }

      case 'messages': {
        const fanUuid = searchParams.get('fanUuid')
        if (!fanUuid) return NextResponse.json({ error: 'Missing fanUuid' }, { status: 400 })
        const data = await getChatMessages(fanUuid)
        return NextResponse.json(data)
      }

      case 'fan-insights': {
        const fanUuid = searchParams.get('fanUuid')
        if (!fanUuid) return NextResponse.json({ error: 'Missing fanUuid' }, { status: 400 })
        const data = await getFanInsights(fanUuid)
        return NextResponse.json(data)
      }

      case 'top-spenders': {
        const data = await getCreatorTopSpenders(searchParams.get('creatorUuid') ?? '')
        return NextResponse.json(data)
      }

      case 'earnings': {
        const data = await getCreatorEarnings(searchParams.get('creatorUuid') ?? '')
        return NextResponse.json(data)
      }

      case 'leaderboard': {
        const data = await getChatterLeaderboard()
        return NextResponse.json(data)
      }

      case 'team': {
        const data = await getTeamMembers()
        return NextResponse.json(data)
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'NOT_CONNECTED') return NextResponse.json({ error: 'NOT_CONNECTED' }, { status: 401 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await isConnected())) {
    return NextResponse.json({ error: 'NOT_CONNECTED' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action')

  try {
    if (action === 'send-message') {
      const { fanUuid, text } = await req.json()
      if (!fanUuid || !text) return NextResponse.json({ error: 'Missing params' }, { status: 400 })
      const data = await sendMessage(fanUuid, text)
      return NextResponse.json(data)
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}