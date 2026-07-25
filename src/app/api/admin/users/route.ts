import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { rows, one, query } from '@/lib/db'
import { requireAdmin } from '@/lib/session'

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (admin instanceof NextResponse) return admin

  const users = await rows(
    `SELECT id,email,display_name,role,active,created_at,last_login_at
     FROM users
     ORDER BY created_at DESC`
  )

  return NextResponse.json({ users })
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (admin instanceof NextResponse) return admin

  const { email, password, display_name, role } = await req.json()

  if (!email || !password || !display_name) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  const existing = await one(
    `SELECT id FROM users WHERE lower(email)=lower($1)`,
    [email]
  )

  if (existing) {
    return NextResponse.json({ error: 'email_taken' }, { status: 409 })
  }

  const hash = await bcrypt.hash(password, 11)

  const user = await one(
    `INSERT INTO users
     (email, display_name, role, password_hash)
     VALUES ($1,$2,$3,$4)
     RETURNING id,email,display_name,role,active,created_at`,
    [
      email.toLowerCase(),
      display_name,
      role === 'admin' ? 'admin' : 'chatter',
      hash,
    ]
  )

  return NextResponse.json({ ok: true, user })
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (admin instanceof NextResponse) return admin

  const { id, display_name, role, active } = await req.json()

  await query(
    `UPDATE users
     SET
       display_name = COALESCE($1, display_name),
       role = COALESCE($2, role),
       active = COALESCE($3, active)
     WHERE id=$4`,
    [display_name ?? null, role ?? null, active ?? null, id]
  )

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (admin instanceof NextResponse) return admin

  const { id } = await req.json()

  await query(`DELETE FROM users WHERE id=$1`, [id])

  return NextResponse.json({ ok: true })
}