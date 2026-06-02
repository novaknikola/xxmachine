import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  await query(`DELETE FROM scheduled_posts WHERE id=$1`, [id])
  return NextResponse.json({ ok: true })
}
