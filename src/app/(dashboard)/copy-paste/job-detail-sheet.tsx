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
import type { CopyPasteSpec } from '@/lib/monitor/copy-paste-spec'

interface ItemLike {
  id: string
  profile: string
  content_url: string
  replicate_status: string
  replicate_error: string | null
  source_duration: number | null
  source_cut_count: number | null
  source_aspect_ratio: string | null
  reference_image_url: string | null
  copy_paste_spec: CopyPasteSpec | null
  rendered_prompt: string | null
  kling_video_url: string | null
  thumbnail_url: string | null
}

const EDITABLE_STATUSES = new Set([
  'classified',
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
  formatUsd,
  onPromptSaved,
}: {
  item: ItemLike | null
  open: boolean
  onOpenChange: (open: boolean) => void
  estimate: CostBreakdown | null
  formatUsd: (n: number) => string
  onPromptSaved?: (update: { id: string; rendered_prompt: string | null }) => void
}) {
  const [renderedPrompt, setRenderedPrompt] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!item) return
    setRenderedPrompt(item.rendered_prompt ?? '')
  }, [item?.id, item?.rendered_prompt])

  if (!item) return null

  const spec = item.copy_paste_spec
  const canEdit = EDITABLE_STATUSES.has(item.replicate_status)
  const dirty = renderedPrompt !== (item.rendered_prompt ?? '')

  async function savePrompt() {
    setSaving(true)
    try {
      const res = await fetch(`/api/monitor/items/${item!.id}/prompts`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rendered_prompt: renderedPrompt }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      toast.success('Prompt saved')
      onPromptSaved?.({
        id: item!.id,
        rendered_prompt: data.item?.rendered_prompt ?? (renderedPrompt.trim() || null),
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
            Analysis JSON, editable prompt, and outputs.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{item.replicate_status}</Badge>
            {item.source_duration != null && (
              <Badge variant="outline">{Number(item.source_duration).toFixed(1)}s</Badge>
            )}
            {item.source_aspect_ratio && (
              <Badge variant="outline">{item.source_aspect_ratio}</Badge>
            )}
            {item.source_cut_count != null && (
              <Badge variant="outline">
                {item.source_cut_count === 0
                  ? 'one continuous shot'
                  : `${item.source_cut_count} cut${item.source_cut_count === 1 ? '' : 's'}`}
              </Badge>
            )}
          </div>

          <section className="space-y-2">
            <h3 className="font-medium">Cost</h3>
            {estimate && (
              <div className="rounded-lg border border-border/60 bg-secondary/30 p-4 space-y-1.5">
                <div className="flex justify-between font-medium">
                  <span>Est. total (Seedance 2.0)</span>
                  <span className="tabular-nums">{formatUsd(estimate.totalUsd)}</span>
                </div>
                <p className="text-xs text-muted-foreground pt-1">{estimate.note}</p>
              </div>
            )}
          </section>

          {item.reference_image_url && (
            <section className="space-y-2">
              <h3 className="font-medium">Reference photo</h3>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.reference_image_url}
                alt=""
                className="w-24 aspect-square object-cover rounded-lg border border-border/60"
              />
            </section>
          )}

          {spec?.people?.length ? (
            <section className="space-y-2">
              <h3 className="font-medium">People</h3>
              <div className="rounded-lg border border-border/60 divide-y divide-border/50 overflow-hidden">
                {spec.people.map((p, i) => (
                  <div key={i} className="px-3 py-2.5 space-y-0.5">
                    <p className="text-xs text-muted-foreground">
                      {p.id || `Person ${i + 1}`}{i === 0 ? ' (reference-locked)' : ''}
                      {p.role ? ` — ${p.role}` : ''}
                    </p>
                    <p className="text-muted-foreground leading-relaxed">{p.appearance}</p>
                    {p.wardrobe && (
                      <p className="text-xs text-muted-foreground/80 leading-relaxed">
                        Wardrobe: {p.wardrobe}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {spec && (
            <section className="space-y-2">
              <h3 className="font-medium">Scene</h3>
              <ul className="space-y-1.5 text-muted-foreground leading-relaxed">
                {spec.environment && <li><span className="text-foreground/80">Environment:</span> {spec.environment}</li>}
                {spec.lighting && <li><span className="text-foreground/80">Lighting:</span> {spec.lighting}</li>}
                {spec.color_grading && <li><span className="text-foreground/80">Color grading:</span> {spec.color_grading}</li>}
                {spec.atmosphere && <li><span className="text-foreground/80">Atmosphere:</span> {spec.atmosphere}</li>}
                {spec.audio && <li><span className="text-foreground/80">Audio:</span> {spec.audio}</li>}
                {spec.pacing && <li><span className="text-foreground/80">Pacing:</span> {spec.pacing}</li>}
                {spec.background_activity && <li><span className="text-foreground/80">Background:</span> {spec.background_activity}</li>}
              </ul>
            </section>
          )}

          {spec?.scene_events?.length ? (
            <section className="space-y-2">
              <h3 className="font-medium">Timeline</h3>
              <div className="rounded-lg border border-border/60 divide-y divide-border/50 overflow-hidden">
                {spec.scene_events.map((e, i) => (
                  <div key={i} className="px-3 py-2.5 space-y-0.5">
                    <p className="text-xs text-muted-foreground tabular-nums">{e.timestamp || `Beat ${i + 1}`}</p>
                    {e.line && (
                      <p className="text-muted-foreground leading-relaxed">
                        {e.speaker && e.speaker !== 'none' ? `${e.speaker}: ` : ''}“{e.line}”
                        {e.delivery ? ` (${e.delivery})` : ''}
                      </p>
                    )}
                    {e.action && <p className="text-xs text-muted-foreground/80 leading-relaxed">{e.action}</p>}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {spec?.shots?.length ? (
            <section className="space-y-2">
              <h3 className="font-medium">Shots</h3>
              <ul className="space-y-2 text-muted-foreground">
                {spec.shots.map((s, i) => (
                  <li key={i} className="leading-relaxed">
                    <span className="text-foreground/90 tabular-nums">{s.time}</span>
                    {s.action ? ` — ${s.action}` : ''}
                    {s.camera_behavior ? ` (${s.camera_behavior})` : ''}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {(spec?.style || spec?.camera_logic) && (
            <section className="space-y-2">
              <h3 className="font-medium">Style</h3>
              <p className="text-muted-foreground leading-relaxed">
                {[spec.style, spec.camera_logic].filter(Boolean).join(' · ')}
              </p>
            </section>
          )}

          {spec?.imperfections?.length ? (
            <section className="space-y-2">
              <h3 className="font-medium">Imperfections</h3>
              <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                {spec.imperfections.map((e, i) => (
                  <li key={i} className="leading-relaxed">{e}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {spec?.end_behavior && (
            <section className="space-y-2">
              <h3 className="font-medium">Ends</h3>
              <p className="text-muted-foreground leading-relaxed">{spec.end_behavior}</p>
            </section>
          )}

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">Rendered prompt</h3>
              {canEdit && (
                <span className="text-xs text-muted-foreground">Sent to Seedance as-is</span>
              )}
            </div>
            {canEdit ? (
              <Textarea
                value={renderedPrompt}
                onChange={e => setRenderedPrompt(e.target.value)}
                rows={12}
                className="text-xs leading-relaxed font-mono"
                placeholder="Prompt sent to Seedance…"
              />
            ) : item.rendered_prompt ? (
              <pre className="whitespace-pre-wrap rounded-lg border border-border/60 bg-secondary/20 p-4 text-xs leading-relaxed text-muted-foreground max-h-64 overflow-y-auto">
                {item.rendered_prompt}
              </pre>
            ) : (
              <p className="text-muted-foreground text-xs">No prompt yet — run Classify first.</p>
            )}
          </section>

          {canEdit && (
            <Button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void savePrompt()}
            >
              {saving ? 'Saving…' : 'Save prompt'}
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
