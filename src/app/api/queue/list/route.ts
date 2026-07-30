import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows } from '@/lib/db'

const MY_POD_TYPES = [
  'comfyui_pod_bulk',
  'my_pod_i2v',
  'my_pod_animate',
  'my_pod_talk',
] as const

/** Drop bulky arrays from list payloads — Queue only needs folder ids + counts. */
function slimJobInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const src = input as Record<string, unknown>
  const out: Record<string, unknown> = { ...src }
  if (Array.isArray(src.items)) {
    out.itemCount = src.items.length
    delete out.items
  }
  if (Array.isArray(src.texts)) {
    out.textCount = src.texts.length
    delete out.texts
  }
  if (Array.isArray(src.spokenTexts)) delete out.spokenTexts
  if (Array.isArray(src.prompts)) {
    out.promptCount = src.prompts.length
    delete out.prompts
  }
  if (Array.isArray(src.jobs)) {
    out.jobCount = src.jobs.length
    delete out.jobs
  }
  if (Array.isArray(src.examples)) {
    out.exampleCount = src.examples.length
    delete out.examples
  }
  return out
}

function slimJobOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  const src = output as Record<string, unknown>
  // Keep myPodRows / comfyuiRows — needed for Queue expand; usually small vs input.items
  return src
}

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const scope = req.nextUrl.searchParams.get('scope')
  const myPodOnly = scope === 'my-pod'

  const jobs = await rows(
    myPodOnly
      ? `SELECT g.id, g.job_type, g.status, g.total_items, g.done_items, g.progress,
                g.error, g.output, g.input, g.attempts, g.created_at, g.started_at, g.finished_at,
                g.pod_session_id,
                ps.name AS pod_name
           FROM generation_queue g
           LEFT JOIN pod_sessions ps ON ps.id = g.pod_session_id
          WHERE g.user_id = $1
            AND g.job_type = ANY($2::text[])
          ORDER BY g.created_at DESC
          LIMIT 50`
      : `SELECT g.id, g.job_type, g.status, g.total_items, g.done_items, g.progress,
                g.error, g.output, g.input, g.attempts, g.created_at, g.started_at, g.finished_at,
                g.pod_session_id,
                ps.name AS pod_name
           FROM generation_queue g
           LEFT JOIN pod_sessions ps ON ps.id = g.pod_session_id
          WHERE g.user_id = $1
          ORDER BY g.created_at DESC
          LIMIT 50`,
    myPodOnly ? [user.id, [...MY_POD_TYPES]] : [user.id],
  )

  const slimmed = jobs.map(j => ({
    ...j,
    input: slimJobInput(j.input),
    output: slimJobOutput(j.output),
  }))

  return NextResponse.json({ jobs: slimmed })
}
