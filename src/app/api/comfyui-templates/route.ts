import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows, one, query } from '@/lib/db'

interface TemplateRow {
  id: string
  name: string
  workflow_json: Record<string, unknown>
  prompt_node_id: string
  prompt_field: string
  image_node_id: string | null
  image_field: string | null
  created_at: string
}

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const templates = await rows<TemplateRow>(
    `SELECT id, name, workflow_json, prompt_node_id, prompt_field, image_node_id, image_field, created_at
       FROM comfyui_templates WHERE user_id = $1 ORDER BY created_at DESC`,
    [user.id],
  )
  return NextResponse.json({ templates })
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const body = await req.json().catch(() => ({})) as {
    name?: string
    workflowJson?: string
    promptNodeId?: string
    promptField?: string
    imageNodeId?: string
    imageField?: string
  }

  if (!body.name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 })
  if (!body.workflowJson?.trim()) return NextResponse.json({ error: 'workflow JSON required' }, { status: 400 })
  if (!body.promptNodeId?.trim()) return NextResponse.json({ error: 'promptNodeId required' }, { status: 400 })

  let workflow: Record<string, unknown>
  try {
    workflow = JSON.parse(body.workflowJson)
  } catch {
    return NextResponse.json({ error: 'workflow JSON is not valid JSON' }, { status: 400 })
  }
  if (typeof workflow !== 'object' || workflow === null || Array.isArray(workflow)) {
    return NextResponse.json({ error: 'workflow JSON must be an object (ComfyUI API-format export)' }, { status: 400 })
  }

  const promptField = body.promptField?.trim() || 'text'
  const promptNode = workflow[body.promptNodeId] as { inputs?: Record<string, unknown> } | undefined
  if (!promptNode || typeof promptNode !== 'object') {
    return NextResponse.json({ error: `Node "${body.promptNodeId}" not found in workflow JSON` }, { status: 400 })
  }
  if (!promptNode.inputs || !(promptField in promptNode.inputs)) {
    return NextResponse.json({ error: `Node "${body.promptNodeId}" has no input field "${promptField}"` }, { status: 400 })
  }

  const imageNodeId = body.imageNodeId?.trim() || null
  const imageField = body.imageField?.trim() || 'image'
  if (imageNodeId) {
    const imageNode = workflow[imageNodeId] as { inputs?: Record<string, unknown> } | undefined
    if (!imageNode || typeof imageNode !== 'object') {
      return NextResponse.json({ error: `Node "${imageNodeId}" not found in workflow JSON` }, { status: 400 })
    }
    if (!imageNode.inputs || !(imageField in imageNode.inputs)) {
      return NextResponse.json({ error: `Node "${imageNodeId}" has no input field "${imageField}"` }, { status: 400 })
    }
  }

  const created = await one<{ id: string }>(
    `INSERT INTO comfyui_templates
       (user_id, name, workflow_json, prompt_node_id, prompt_field, image_node_id, image_field)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [user.id, body.name.trim(), JSON.stringify(workflow), body.promptNodeId.trim(), promptField, imageNodeId, imageField],
  )
  return NextResponse.json({ id: created!.id })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { id } = await req.json().catch(() => ({})) as { id?: string }
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const result = await query(`DELETE FROM comfyui_templates WHERE id = $1 AND user_id = $2`, [id, user.id])
  if (result.rowCount === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
