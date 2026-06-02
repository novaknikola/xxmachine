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
  isConnected,
} from '@/lib/fanvue'

export async function GET(req: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: 'NOT_CONNECTED' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action')

  try {
    switch (action) {
      case 'creators': {
        const data = await getAgencyCreators()
        return NextResponse.json(data)
      }
      case 'chats': {
        const creatorUuid = searchParams.get('creatorUuid')
        if (!creatorUuid) return NextResponse.json({ error: 'Missing creatorUuid' }, { status: 400 })
        const data = await getCreatorChats(creatorUuid)
        return NextResponse.json(data)
      }
      case 'messages': {
        const creatorUuid = searchParams.get('creatorUuid')
        const fanUuid = searchParams.get('fanUuid')
        if (!creatorUuid || !fanUuid) return NextResponse.json({ error: 'Missing params' }, { status: 400 })
        const data = await getCreatorMessages(creatorUuid, fanUuid)
        return NextResponse.json(data)
      }
      case 'top-spenders': {
        const creatorUuid = searchParams.get('creatorUuid')
        if (!creatorUuid) return NextResponse.json({ error: 'Missing creatorUuid' }, { status: 400 })
        const data = await getCreatorTopSpenders(creatorUuid)
        return NextResponse.json(data)
      }
      case 'earnings': {
        const creatorUuid = searchParams.get('creatorUuid')
        if (!creatorUuid) return NextResponse.json({ error: 'Missing creatorUuid' }, { status: 400 })
        const data = await getCreatorEarnings(creatorUuid)
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
      case 'status': {
        return NextResponse.json({ connected: true })
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
  if (!isConnected()) {
    return NextResponse.json({ error: 'NOT_CONNECTED' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action')

  try {
    if (action === 'send-message') {
      const { creatorUuid, fanUuid, text } = await req.json()
      if (!creatorUuid || !fanUuid || !text) {
        return NextResponse.json({ error: 'Missing params' }, { status: 400 })
      }
      const data = await sendMessageAsCreator(creatorUuid, fanUuid, text)
      return NextResponse.json(data)
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
