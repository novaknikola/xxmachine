'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { CostBreakdown } from '@/lib/monitor/cost-estimate'

interface ActionBeat {
  t?: number
  subject?: string
  background?: string
}

interface ItemLike {
  id: string
  profile: string
  content_url: string
  replicate_status: string
  replicate_error: string | null
  scene_prompt: string | null
  motion_prompt?: string | null
  technique_reasoning: string | null
  video_technique: string | null
  technique_confidence: number | null
  source_duration: number | null
  source_cut_count: number | null
  generated_image_url: string | null
  generated_end_image_url: string | null
  kling_video_url: string | null
  thumbnail_url: string | null
  scene_spec?: {
    speech?: { transcript?: string; kind?: string }
    on_screen_text?: string
    on_screen_text_style?: string
    action_beats?: ActionBeat[]
    must_include_events?: string[]
    background_people?: Array<{ who?: string; action?: string; position?: string }>
  } | null
}

const EDITABLE_STATUSES = new Set([
  'classified',
  'image_done',
  'needs_review',
  'failed',
  'pending_classify',
  'none',
])

export function JobDetailSheet({
  item,
  open,
  onOpenChange,
  estimate,
  imageModelLabel,
  videoLabel,
  soundLabel,
  formatUsd,
  onPromptsSaved,
}: {
  item: ItemLike | null
  open: boolean
  onOpenChange: (open: boolean) => void
  estimate: CostBreakdown | null
  imageModelLabel: string
  videoLabel: string
  soundLabel: string
  formatUsd: (n: number) => string
  onPromptsSaved?: (update: { id: string; scene_prompt: string | null; motion_prompt: string | null }) => void
}) {
  const [scenePrompt, setScenePrompt] = useState('')
  const [motionPrompt, setMotionPrompt] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!item) return
    setScenePrompt(item.scene_prompt ?? '')
    setMotionPrompt(item.motion_prompt ?? '')
  }, [item?.id, item?.scene_prompt, item?.motion_prompt])

  if (!item) return null

  const spec = item.scene_spec
  const transcript = spec?.speech?.transcript?.trim()
  const speechKind = spec?.speech?.kind
  const caption = spec?.on_screen_text?.trim()
  const beats = (spec?.action_beats ?? []).filter(b => b.subject?.trim())
  const events = (spec?.must_include_events ?? []).filter(Boolean)
  const cast = (spec?.background_people ?? []).filter(p => p.who || p.action)
  const canEdit = EDITABLE_STATUSES.has(item.replicate_status)
  const dirty =
    scenePrompt !== (item.scene_prompt ?? '') ||
    motionPrompt !== (item.motion_prompt ?? '')

  async function savePrompts() {
    setSaving(true)
    try {
      const res = await fetch(`/api/monitor/items/${item!.id}/prompts`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene_prompt: scenePrompt,
          motion_prompt: motionPrompt,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      toast.success('Prompts saved')
      onPromptsSaved?.({
        id: item!.id,
        scene_prompt: data.item?.scene_prompt ?? (scenePrompt.trim() || null),
        motion_prompt: data.item?.motion_prompt ?? (motionPrompt.trim() || null),
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg overflow-y-auto px-6 py-6">
        <SheetHeader className="gap-2 text-left">
          <SheetTitle>@{item.profile}</SheetTitle>
          <SheetDescription>
            Full analysis, pipeline, prompts, and outputs.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{item.replicate_status}</Badge>
            {item.video_technique && <Badge variant="outline">{item.video_technique}</Badge>}
            {item.technique_confidence != null && (
              <Badge variant="outline">
                {Math.round(item.technique_confidence * 100)}% confidence
              </Badge>
            )}
            {item.source_duration != null && (
              <Badge variant="outline">{Number(item.source_duration).toFixed(1)}s</Badge>
            )}
            {item.source_cut_count != null && (
              <Badge variant="outline">
                {item.source_cut_count === 0
                  ? 'one continuous shot'
                  : `${item.source_cut_count} cut${item.source_cut_count === 1 ? '' : 's'}`}
              </Badge>
            )}
            {transcript && <Badge variant="outline">has speech</Badge>}
          </div>

          <section className="space-y-2">
            <h3 className="font-medium">Pipeline</h3>
            <p className="text-muted-foreground leading-relaxed">
              {imageModelLabel} → {videoLabel} · Sound: {soundLabel}
            </p>
            {estimate && (
              <div className="rounded-lg border border-border/60 bg-secondary/30 p-4 space-y-1.5">
                <div className="flex justify-between"><span>Image</span><span className="tabular-nums">{formatUsd(estimate.imageUsd)}</span></div>
                <div className="flex justify-between"><span>Video</span><span className="tabular-nums">{formatUsd(estimate.videoUsd)}</span></div>
                <div className="flex justify-between"><span>Audio</span><span className="tabular-nums">{formatUsd(estimate.audioUsd)}</span></div>
                <div className="flex justify-between font-medium pt-1 border-t border-border/50">
                  <span>Est. total</span>
                  <span className="tabular-nums">{formatUsd(estimate.totalUsd)}</span>
                </div>
                <p className="text-xs text-muted-foreground pt-1">{estimate.note}</p>
              </div>
            )}
          </section>

          {item.technique_reasoning && (
            <section className="space-y-2">
              <h3 className="font-medium">Technique notes</h3>
              <p className="text-muted-foreground leading-relaxed">{item.technique_reasoning}</p>
            </section>
          )}

          {caption && (
            <section className="space-y-2">
              <h3 className="font-medium">On-screen caption</h3>
              <p className="text-muted-foreground leading-relaxed">“{caption}”</p>
              {spec?.on_screen_text_style && (
                <p className="text-xs text-muted-foreground">{spec.on_screen_text_style}</p>
              )}
            </section>
          )}

          {transcript && (
            <section className="space-y-2">
              <h3 className="font-medium">Speech</h3>
              {speechKind && speechKind !== 'unknown' && (
                <p className="text-xs text-muted-foreground capitalize">{speechKind}</p>
              )}
              <p className="text-muted-foreground leading-relaxed">“{transcript}”</p>
            </section>
          )}

          {beats.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-medium">Action timeline</h3>
              <div className="rounded-lg border border-border/60 divide-y divide-border/50 overflow-hidden">
                {beats.map((b, i) => (
                  <div key={i} className="px-3 py-2.5 space-y-0.5">
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {typeof b.t === 'number' && Number.isFinite(b.t) ? `${b.t.toFixed(1)}s` : `Beat ${i + 1}`}
                    </p>
                    <p className="text-muted-foreground leading-relaxed">{b.subject}</p>
                    {b.background?.trim() && (
                      <p className="text-xs text-muted-foreground/80 leading-relaxed">
                        BG: {b.background}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {events.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-medium">Must-include events</h3>
              <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                {events.map((e, i) => (
                  <li key={i} className="leading-relaxed">{e}</li>
                ))}
              </ul>
            </section>
          )}

          {cast.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-medium">Other people</h3>
              <ul className="space-y-2 text-muted-foreground">
                {cast.map((p, i) => (
                  <li key={i} className="leading-relaxed">
                    <span className="text-foreground/90">{p.who || 'Person'}</span>
                    {p.position ? ` (${p.position})` : ''}
                    {p.action ? ` — ${p.action}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">Scene prompt</h3>
              {canEdit && (
                <span className="text-xs text-muted-foreground">Editable before Replicate</span>
              )}
            </div>
            {canEdit ? (
              <Textarea
                value={scenePrompt}
                onChange={e => setScenePrompt(e.target.value)}
                rows={8}
                className="text-xs leading-relaxed font-mono"
                placeholder="Scene / keyframe prompt…"
              />
            ) : item.scene_prompt ? (
              <pre className="whitespace-pre-wrap rounded-lg border border-border/60 bg-secondary/20 p-4 text-xs leading-relaxed text-muted-foreground max-h-64 overflow-y-auto">
                {item.scene_prompt}
              </pre>
            ) : (
              <p className="text-muted-foreground text-xs">No scene prompt yet — run Classify first.</p>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">Motion prompt</h3>
              {canEdit && (
                <span className="text-xs text-muted-foreground">Used by Seedance / I2V</span>
              )}
            </div>
            {canEdit ? (
              <Textarea
                value={motionPrompt}
                onChange={e => setMotionPrompt(e.target.value)}
                rows={6}
                className="text-xs leading-relaxed font-mono"
                placeholder="Motion timeline prompt (filled on Replicate if empty)…"
              />
            ) : item.motion_prompt ? (
              <pre className="whitespace-pre-wrap rounded-lg border border-border/60 bg-secondary/20 p-4 text-xs leading-relaxed text-muted-foreground max-h-48 overflow-y-auto">
                {item.motion_prompt}
              </pre>
            ) : (
              <p className="text-muted-foreground text-xs">No motion prompt yet — generated on Replicate if empty.</p>
            )}
          </section>

          {canEdit && (
            <Button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void savePrompts()}
            >
              {saving ? 'Saving…' : 'Save prompts'}
            </Button>
          )}

          {item.replicate_error && (
            <section className="space-y-2">
              <h3 className="font-medium text-destructive">Error</h3>
              <p className="text-destructive/90">{item.replicate_error}</p>
            </section>
          )}

          <section className="space-y-3">
            <h3 className="font-medium">Outputs</h3>
            <div className="flex flex-col gap-2">
              <a className="text-primary hover:underline" href={item.content_url} target="_blank" rel="noopener noreferrer">
                Source post
              </a>
              {item.generated_image_url && (
                <a className="text-primary hover:underline" href={item.generated_image_url} target="_blank" rel="noopener noreferrer">
                  Generated image
                </a>
              )}
              {item.generated_end_image_url && (
                <a className="text-primary hover:underline" href={item.generated_end_image_url} target="_blank" rel="noopener noreferrer">
                  End frame
                </a>
              )}
              {item.kling_video_url && (
                <a className="text-primary hover:underline" href={item.kling_video_url} target="_blank" rel="noopener noreferrer">
                  Generated video
                </a>
              )}
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
