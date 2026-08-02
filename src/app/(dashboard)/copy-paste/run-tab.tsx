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
  ImageIcon, Video, Sparkles, Eye, SquareStack,
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
  generated_image_url: string | null
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

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/monitor/items?status=${filter}`)
      const data = await res.json()
      setItems(data.items ?? [])
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  function reload() {
    setLoading(true)
    load()
  }

  const avgEstimate = useMemo(() => {
    if (!items.length) return studio.estimateFor(7)
    const avgDur =
      items.reduce((s, i) => s + (i.source_duration ?? 7), 0) / items.length
    return studio.estimateFor(avgDur)
  }, [items, studio])

  async function runAction(id: string, action: 'classify' | 'replicate') {
    if (action === 'replicate' && filter === 'pending') {
      setFilter('active')
    }
    setWorking(id)
    studio.setQueueBusy(1)
    try {
      const res = await fetch(`/api/monitor/${action}/${id}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      if (action === 'classify') {
        toast.success('Analyzed')
      } else {
        toast.success('Replication complete')
        const item = items.find(i => i.id === id)
        studio.logEstimatedSpend({
          itemId: id,
          profile: item?.profile,
          durationSec: item?.source_duration,
        })
      }
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setWorking(null)
      studio.setQueueBusy(0)
    }
  }

  async function runBatch() {
    const targets = items.filter(i =>
      selected.has(i.id)
      && i.replicate_status !== 'done'
      && i.replicate_status !== 'skipped',
    )
    if (!targets.length) {
      toast.message('Select items to batch replicate')
      return
    }
    try {
      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'copy_paste_v2',
          input: { itemIds: targets.map(i => i.id) },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(
        `${targets.length} sent to queue`,
        {
          description: 'Processing continues in the background — you can leave the page',
          action: { label: 'Open Queue', onClick: () => { window.location.href = '/captions?tab=queue' } },
        },
      )
      setSelected(new Set())
      reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Queue submit failed')
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
            const est = studio.estimateFor(item.source_duration)
            const step = stepIndex(item.replicate_status)
            const summary = specSummary(item.copy_paste_spec)
            const hasSpec = Boolean(item.copy_paste_spec)
            const stillClassifying = item.replicate_status === 'pending_classify' && !hasSpec
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
                        {(item.replicate_status === 'failed' || stillClassifying) && (
                          <Button
                            variant="outline"
                            disabled={working === item.id}
                            onClick={() => runAction(item.id, 'classify')}
                          >
                            {working === item.id
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <Sparkles className="w-4 h-4" />}
                            Retry analyze
                          </Button>
                        )}
                        {item.replicate_status !== 'done'
                          && item.replicate_status !== 'skipped'
                          && item.replicate_status !== 'analyzing'
                          && item.replicate_status !== 'image_generating'
                          && item.replicate_status !== 'video_generating'
                          && !stillClassifying && (
                          <Button
                            disabled={working === item.id || !item.reference_image_url}
                            onClick={() => runAction(item.id, 'replicate')}
                          >
                            {working === item.id
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <Play className="w-4 h-4" />}
                            {item.replicate_status === 'needs_review' ? 'Replicate anyway' : 'Replicate'}
                          </Button>
                        )}
                        {(item.replicate_status === 'analyzing'
                          || item.replicate_status === 'image_generating'
                          || item.replicate_status === 'video_generating'
                          || stillClassifying) && (
                          <Button variant="outline" disabled>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {item.replicate_status === 'video_generating'
                              ? 'Generating video…'
                              : item.replicate_status === 'image_generating'
                                ? 'Generating keyframe…'
                                : 'Analyzing…'}
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
        estimate={detailItem ? studio.estimateFor(detailItem.source_duration) : null}
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
