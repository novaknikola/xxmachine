'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import {
  Loader2, Play, RefreshCw, CheckCircle2, XCircle, ExternalLink,
  ImageIcon, Video, Sparkles, Eye, SquareStack, Copy,
} from 'lucide-react'
import { useStudioSettings } from './studio-settings'
import type { CopyPasteSpec } from '@/lib/monitor/copy-paste-spec'
import { JobDetailSheet } from './job-detail-sheet'
import { PasteUrlsPanel } from './paste-urls-panel'

interface ReplicateItem {
  id: string
  profile: string
  content_url: string
  content_type: string | null
  source_duration: number | null
  source_cut_count: number | null
  source_aspect_ratio: string | null
  video_model: string | null
  score: number
  replicate_status: string
  replicate_error: string | null
  reference_image_url: string | null
  source_first_frame_url: string | null
  source_last_frame_url: string | null
  generated_image_url: string | null
  generated_end_image_url: string | null
  copy_paste_spec: CopyPasteSpec | null
  rendered_prompt: string | null
  kling_video_url: string | null
  thumbnail_url: string | null
  discovered_at: string
}

function specSummary(spec: CopyPasteSpec | null): string | null {
  if (!spec) return null
  const bits = [
    spec.people?.length ? `${spec.people.length} ${spec.people.length === 1 ? 'person' : 'people'}` : null,
    spec.environment,
    spec.style,
  ].filter(Boolean)
  return bits.length ? bits.join(' · ') : null
}

const STATUS_LABEL: Record<string, string> = {
  pending_classify: 'Classifying…',
  classified: 'Ready',
  analyzing: 'Analyzing',
  image_generating: 'Generating keyframe',
  image_done: 'Keyframe ready',
  video_generating: 'Generating video',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  needs_review: 'Needs review',
}

const PIPELINE_STEPS = [
  'pending_classify',
  'classified',
  'analyzing',
  'image_generating',
  'image_done',
  'video_generating',
  'done',
] as const

function stepIndex(status: string): number {
  if (status === 'failed' || status === 'skipped' || status === 'needs_review') return -1
  const i = PIPELINE_STEPS.indexOf(status as typeof PIPELINE_STEPS[number])
  return i >= 0 ? i : 0
}

/** Server is mid-work on these — the list auto-refreshes while any item is here. */
const ACTIVE_STATUSES = new Set([
  'pending_classify',
  'analyzing',
  'image_generating',
  'image_done',
  'video_generating',
])
const POLL_MS = 6_000

const FILTERS = ['active', 'pending', 'review', 'done', 'failed'] as const
type Filter = typeof FILTERS[number]

export function RunTab() {
  const studio = useStudioSettings()
  const [items, setItems] = useState<ReplicateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('active')
  const [working, setWorking] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detailId, setDetailId] = useState<string | null>(null)
  /** Submitted to the queue but the worker has not flipped their status yet. */
  const [queuedIds, setQueuedIds] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/monitor/items?status=${filter}`)
      const data = await res.json()
      const next: ReplicateItem[] = data.items ?? []
      setItems(next)
      // Once the worker picks an item up (or finishes it), its own status is the
      // truth — drop the optimistic "Queued" marker.
      setQueuedIds(prev => {
        if (!prev.size) return prev
        const still = new Set(
          [...prev].filter(id => {
            const it = next.find(i => i.id === id)
            return it != null
              && !ACTIVE_STATUSES.has(it.replicate_status)
              && it.replicate_status !== 'done'
              && it.replicate_status !== 'failed'
          }),
        )
        return still.size === prev.size ? prev : still
      })
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  const hasActive = items.some(i => ACTIVE_STATUSES.has(i.replicate_status)) || queuedIds.size > 0

  // Generation runs server-side now, so the list has to pull its own updates.
  useEffect(() => {
    if (!hasActive) return
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, POLL_MS)
    return () => clearInterval(t)
  }, [hasActive, load])

  function reload() {
    setLoading(true)
    load()
  }

  const avgEstimate = useMemo(() => {
    if (!items.length) return studio.estimateFor(7, 0)
    const avgDur =
      items.reduce((s, i) => s + (i.source_duration ?? 7), 0) / items.length
    // Quote the common case rather than a blend: most sources here are single-shot.
    const anyCut = items.some(i => (i.source_cut_count ?? 0) > 0)
    return studio.estimateFor(avgDur, anyCut ? 1 : 0)
  }, [items, studio])

  async function runClassify(id: string) {
    setWorking(id)
    try {
      const res = await fetch(`/api/monitor/classify/${id}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Analyzed')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setWorking(null)
    }
  }

  /**
   * One item and a whole selection take the same path: a server-side queue job.
   * A keyframe plus a Seedance render runs for minutes, which is far longer than
   * a browser request (or nginx) will hold open.
   */
  async function submitReplicate(targets: ReplicateItem[]) {
    if (!targets.length) {
      toast.message('Select items to replicate')
      return
    }
    if (filter === 'pending') setFilter('active')
    try {
      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'copy_paste_v2',
          input: {
            itemIds: targets.map(i => i.id),
            endFrame: studio.endFrame,
            repurposeCount: studio.repurposeCount,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setQueuedIds(prev => new Set([...prev, ...targets.map(i => i.id)]))
      for (const item of targets) {
        studio.logEstimatedSpend({
          itemId: item.id,
          profile: item.profile,
          durationSec: item.source_duration,
          cutCount: item.source_cut_count,
        })
      }
      toast.success(
        targets.length === 1 ? 'Queued — generating…' : `${targets.length} queued — generating…`,
        {
          description: 'Runs in the background — you can leave the page',
          action: { label: 'Open Queue', onClick: () => { window.location.href = '/captions?tab=queue' } },
        },
      )
      setSelected(new Set())
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Queue submit failed')
    }
  }

  function runBatch() {
    return submitReplicate(items.filter(i =>
      selected.has(i.id)
      && i.replicate_status !== 'done'
      && i.replicate_status !== 'skipped',
    ))
  }

  /**
   * Fan an already-finished video out again. Replicate cannot do this: it
   * returns the cached video before reaching the repurpose step, so a done item
   * can never gain variants that way. Goes straight to the same queue job the
   * Copy-Paste chain enqueues, with the same all-effects-on settings.
   */
  async function repurposeAgain(item: ReplicateItem) {
    if (!item.kling_video_url || studio.repurposeCount < 1) return
    setWorking(item.id)
    try {
      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'video_repurpose',
          input: {
            videoUrl: item.kling_video_url,
            videoName: `copypaste_${item.id.slice(0, 8)}.mp4`,
            count: studio.repurposeCount,
            effects: {
              brightness: true, contrast: true, saturation: true,
              hue: true, speed: true, flipH: true, crop: true, fade: false,
            },
            archiveToDrive: true,
            characterKey: item.profile,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(`${studio.repurposeCount} variants queued — archiving to Drive`, {
        description: 'Starts within a minute; you can leave the page',
        action: { label: 'Open Queue', onClick: () => { window.location.href = '/captions?tab=queue' } },
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Repurpose submit failed')
    } finally {
      setWorking(null)
    }
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const detailItem = items.find(i => i.id === detailId) ?? null

  return (
    <div className="space-y-6">
      <PasteUrlsPanel
        onEnqueued={() => {
          if (filter === 'pending') {
            reload()
          } else {
            setLoading(true)
            setFilter('pending')
          }
        }}
      />

      <div className="sticky top-0 z-20 -mx-1 px-1 py-3 bg-background/90 backdrop-blur-md border-b border-border/60 space-y-5">
        <div className="flex flex-wrap items-end gap-4">
          <Field className="w-[140px]">
            <FieldLabel>Mode</FieldLabel>
            <Select
              value={studio.runMode}
              onValueChange={v => {
                if (v === 'one' || v === 'batch') studio.setRunMode(v)
              }}
            >
              <SelectTrigger className="w-full min-w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="one">One shot</SelectItem>
                <SelectItem value="batch">Batch</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field className="w-[210px]">
            <FieldLabel>End frame</FieldLabel>
            <Select
              value={studio.endFrame}
              onValueChange={v => {
                if (v === 'auto' || v === 'always' || v === 'off') studio.setEndFrame(v)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (single-shot only)</SelectItem>
                <SelectItem value="always">Always</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field className="w-[190px]">
            <FieldLabel>Repurpose after</FieldLabel>
            <Select
              value={String(studio.repurposeCount)}
              onValueChange={v => studio.setRepurposeCount(Number(v) || 0)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Off</SelectItem>
                <SelectItem value="3">×3 variants</SelectItem>
                <SelectItem value="5">×5 variants</SelectItem>
                <SelectItem value="10">×10 variants</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <div className="ml-auto flex flex-col items-end gap-1 pb-0.5">
            <span className="text-xs text-muted-foreground">Est. / video (keyframe + Seedance)</span>
            <span className="text-lg font-semibold tabular-nums">
              {studio.formatUsd(avgEstimate.totalUsd)}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {FILTERS.map(f => (
              <button
                key={f}
                onClick={() => { setLoading(true); setFilter(f) }}
                className={`px-3.5 py-2 text-sm rounded-lg capitalize transition-colors ${
                  filter === f ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {studio.runMode === 'batch' && (
              <Button
                variant="default"
                disabled={selected.size === 0}
                onClick={runBatch}
              >
                <SquareStack className="w-4 h-4" />
                Replicate selected ({selected.size})
              </Button>
            )}
            <Button variant="outline" onClick={reload}>
              <RefreshCw className="w-4 h-4" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center text-muted-foreground">
            No items in this queue. Paste a reel URL and upload a reference photo above.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {items.map(item => {
            const est = studio.estimateFor(item.source_duration, item.source_cut_count)
            const step = stepIndex(item.replicate_status)
            const summary = specSummary(item.copy_paste_spec)
            const isActive = ACTIVE_STATUSES.has(item.replicate_status)
            const isQueued = queuedIds.has(item.id)
            return (
              <Card key={item.id} className="bg-card/80">
                <CardContent className="pt-1">
                  <div className="flex gap-5">
                    {studio.runMode === 'batch' && (
                      <label className="pt-2 shrink-0">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={selected.has(item.id)}
                          onChange={() => toggleSelect(item.id)}
                        />
                      </label>
                    )}
                    <div className="shrink-0 flex gap-1.5">
                      <a
                        href={item.generated_image_url || item.thumbnail_url || item.content_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-24 sm:w-28 aspect-[9/16] rounded-lg overflow-hidden bg-secondary/50 ring-1 ring-border/60"
                      >
                        {item.generated_image_url || item.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.generated_image_url || item.thumbnail_url || ''}
                            alt=""
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                            <ImageIcon className="w-6 h-6 opacity-40" />
                          </div>
                        )}
                      </a>
                      {item.reference_image_url && (
                        <a
                          href={item.reference_image_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Reference photo"
                          className="w-10 aspect-square rounded-lg overflow-hidden bg-secondary/50 ring-1 ring-primary/40"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={item.reference_image_url} alt="" className="w-full h-full object-cover" />
                        </a>
                      )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-base">@{item.profile}</span>
                            {item.source_aspect_ratio && (
                              <Badge variant="outline">{item.source_aspect_ratio}</Badge>
                            )}
                            <Badge variant="secondary">
                              {STATUS_LABEL[item.replicate_status] ?? item.replicate_status}
                            </Badge>
                            <span className="text-sm text-muted-foreground">
                              score {Number(item.score).toFixed(1)}
                            </span>
                          </div>

                          <p className="text-sm text-muted-foreground">
                            {item.source_duration != null && `${Number(item.source_duration).toFixed(1)}s source`}
                            {item.source_duration != null && item.source_cut_count != null && ' · '}
                            {item.source_cut_count != null && (
                              item.source_cut_count === 0
                                ? 'one continuous shot'
                                : `${item.source_cut_count} cut${item.source_cut_count === 1 ? '' : 's'}`
                            )}
                            {' · '}
                            est. {studio.formatUsd(est.totalUsd)}
                          </p>

                          {summary && (
                            <p className="text-sm text-muted-foreground/90 leading-relaxed line-clamp-2">
                              {summary}
                            </p>
                          )}

                          {item.replicate_error && (
                            <p className="text-sm text-destructive">{item.replicate_error}</p>
                          )}
                        </div>
                        <a
                          href={item.content_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground shrink-0 p-1"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </div>

                      <div className="flex gap-1.5">
                        {PIPELINE_STEPS.map((s, i) => (
                          <div
                            key={s}
                            title={STATUS_LABEL[s] ?? s}
                            className={`h-1.5 flex-1 rounded-full ${
                              item.replicate_status === 'failed'
                                ? 'bg-destructive/40'
                                : step >= i
                                  ? 'bg-primary'
                                  : 'bg-secondary'
                            }`}
                          />
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {item.replicate_status === 'failed' && (
                          <Button
                            variant="outline"
                            disabled={working === item.id}
                            onClick={() => runClassify(item.id)}
                          >
                            {working === item.id
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <Sparkles className="w-4 h-4" />}
                            Re-analyze
                          </Button>
                        )}
                        {isActive || isQueued ? (
                          <Button variant="outline" disabled>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {isQueued && !isActive
                              ? 'Queued…'
                              : item.replicate_status === 'video_generating'
                                ? 'Generating video…'
                                : item.replicate_status === 'image_generating'
                                  ? 'Generating keyframe…'
                                  : item.replicate_status === 'image_done'
                                    ? 'Keyframe ready…'
                                    : 'Analyzing…'}
                          </Button>
                        ) : item.replicate_status !== 'done' && item.replicate_status !== 'skipped' && (
                          <Button
                            disabled={!item.reference_image_url}
                            onClick={() => submitReplicate([item])}
                          >
                            <Play className="w-4 h-4" />
                            {item.replicate_status === 'needs_review' ? 'Replicate anyway' : 'Replicate'}
                          </Button>
                        )}
                        <Button variant="ghost" onClick={() => setDetailId(item.id)}>
                          <Eye className="w-4 h-4" />
                          Details
                        </Button>
                        {item.kling_video_url && (
                          <a
                            href={item.kling_video_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 text-sm text-primary px-2 py-1.5"
                          >
                            <Video className="w-4 h-4" /> Video
                          </a>
                        )}
                        {item.replicate_status === 'done'
                          && item.kling_video_url
                          && studio.repurposeCount > 0 && (
                          <Button
                            variant="outline"
                            disabled={working === item.id}
                            onClick={() => repurposeAgain(item)}
                          >
                            {working === item.id
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <Copy className="w-4 h-4" />}
                            Repurpose ×{studio.repurposeCount}
                          </Button>
                        )}
                        {item.replicate_status === 'done' && (
                          <CheckCircle2 className="w-5 h-5 text-emerald-400 ml-1" />
                        )}
                        {item.replicate_status === 'failed' && (
                          <XCircle className="w-5 h-5 text-destructive ml-1" />
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <JobDetailSheet
        item={detailItem}
        open={!!detailItem}
        onOpenChange={open => { if (!open) setDetailId(null) }}
        estimate={detailItem ? studio.estimateFor(detailItem.source_duration, detailItem.source_cut_count) : null}
        formatUsd={studio.formatUsd}
        onPromptSaved={update => {
          setItems(prev => prev.map(i => (
            i.id === update.id ? { ...i, rendered_prompt: update.rendered_prompt } : i
          )))
        }}
      />
    </div>
  )
}
