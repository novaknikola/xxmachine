'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldHint, FieldLabel } from '@/components/ui/field'
import {
  Loader2, Play, RefreshCw, CheckCircle2, XCircle, ExternalLink,
  ImageIcon, Video, Sparkles, Eye, SquareStack,
} from 'lucide-react'
import {
  IMAGE_MODEL_LABEL,
  SOUND_OPTIONS,
  VIDEO_BACKEND_OPTIONS,
  useStudioSettings,
} from './studio-settings'
import type { ImageModelChoice, VideoBackendChoice } from '@/lib/monitor/cost-estimate'
import { JobDetailSheet } from './job-detail-sheet'

interface ReplicateItem {
  id: string
  profile: string
  content_url: string
  content_type: string | null
  video_technique: string | null
  technique_confidence: number | null
  technique_reasoning: string | null
  source_duration: number | null
  source_cut_count: number | null
  video_model: string | null
  image_model: string | null
  score: number
  replicate_status: string
  replicate_error: string | null
  scene_prompt: string | null
  scene_spec: {
    body?: {
      bust?: string
      glutes?: string
      build?: string
      hair?: string
      proportion_emphasis?: string
    }
    wardrobe?: { garments?: string; coverage?: string }
    pose?: { body_position?: string; hips_to_camera?: string }
    hook?: { eye_catching?: string; suggestiveness?: string }
    others?: { count?: number; actions?: string }
    background_people?: Array<{ who?: string; action?: string }>
    must_include_events?: string[]
    speech?: { transcript?: string; kind?: string }
    framing?: { shot_size?: string; emphasis?: string }
  } | null
  generated_image_url: string | null
  generated_end_image_url: string | null
  kling_video_url: string | null
  thumbnail_url: string | null
  discovered_at: string
}

function sceneSpecSummary(spec: ReplicateItem['scene_spec']): string | null {
  if (!spec) return null
  const bg =
    spec.must_include_events?.length
      ? spec.must_include_events.join('; ')
      : spec.background_people?.map(p => [p.who, p.action].filter(Boolean).join(': ')).filter(Boolean).join(' | ')
        || ((spec.others?.count ?? 0) > 0
          ? `${spec.others!.count} other(s)${spec.others?.actions ? ` — ${spec.others.actions}` : ''}`
          : '')
  const bits = [
    spec.body?.proportion_emphasis
      || [spec.body?.build, spec.body?.bust && `${spec.body.bust} bust`, spec.body?.glutes && `${spec.body.glutes} glutes`]
        .filter(Boolean).join(', '),
    spec.wardrobe?.garments,
    [spec.pose?.body_position, spec.pose?.hips_to_camera && `hips ${spec.pose.hips_to_camera}`]
      .filter(Boolean).join('; '),
    spec.hook?.eye_catching,
    bg && `BG: ${bg}`,
    spec.speech?.transcript && `speech: "${spec.speech.transcript.slice(0, 80)}${spec.speech.transcript.length > 80 ? '…' : ''}"`,
  ].filter(Boolean)
  return bits.length ? bits.join(' · ') : null
}

const STATUS_LABEL: Record<string, string> = {
  pending_classify: 'Needs classify',
  classified: 'Classified',
  analyzing: 'Analyzing scene',
  image_generating: 'Generating image',
  image_done: 'Image ready',
  video_generating: 'Generating video',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  needs_review: 'Needs review',
}

const TECHNIQUE_LABEL: Record<string, string> = {
  motion_transfer: 'Motion transfer',
  image_to_video: 'Image to video',
  first_last_frame: 'First / last frame',
  multi_shot: 'Multi-shot',
  extend: 'Extended shot',
  unknown: 'Unknown technique',
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
    if (studio.stopRequested && action === 'replicate') {
      toast.message('Stopped — clear stop or turn Autopilot back on to continue')
      return
    }
    setWorking(id)
    studio.setQueueBusy(1)
    try {
      const res = await fetch(`/api/monitor/${action}/${id}`, {
        method: 'POST',
        headers: action === 'replicate' ? { 'Content-Type': 'application/json' } : undefined,
        body: action === 'replicate'
          ? JSON.stringify({
              image_model: studio.imageModel,
              seedream_resolution: studio.seedreamResolution,
              video_backend: studio.videoBackend,
              // Sound wiring lands with Fish mux; preference is stored client-side for now.
              sound_mode: studio.sound,
            })
          : undefined,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      if (action === 'classify') {
        toast.success('Classified')
      } else if (data.queued) {
        toast.success('Multi-shot queued — stitching runs in the background')
        const item = items.find(i => i.id === id)
        studio.logEstimatedSpend({
          itemId: id,
          profile: item?.profile,
          durationSec: item?.source_duration,
        })
      } else {
        toast.success(
          studio.imageModel === 'seedream_edit'
            ? 'Replication complete (Seedream keyframe)'
            : 'Replication complete (Z-Image keyframe)',
        )
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
    studio.clearStop()
    const targets = items.filter(i =>
      selected.has(i.id)
      && i.replicate_status !== 'done'
      && i.replicate_status !== 'skipped',
    )
    if (!targets.length) {
      toast.message('Select items to batch replicate')
      return
    }
    studio.setQueueBusy(targets.length)
    for (const item of targets) {
      if (studio.isStopRequested()) {
        toast.message('Batch stopped')
        break
      }
      setWorking(item.id)
      try {
        const res = await fetch(`/api/monitor/replicate/${item.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_model: studio.imageModel,
            seedream_resolution: studio.seedreamResolution,
            video_backend: studio.videoBackend,
            sound_mode: studio.sound,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error)
        studio.logEstimatedSpend({
          itemId: item.id,
          profile: item.profile,
          durationSec: item.source_duration,
        })
      } catch (err) {
        toast.error(`@${item.profile}: ${err instanceof Error ? err.message : 'Failed'}`)
      }
      studio.setQueueBusy(n => Math.max(0, n - 1))
    }
    setWorking(null)
    studio.setQueueBusy(0)
    setSelected(new Set())
    load()
    toast.success('Batch finished')
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
  const soundHint = SOUND_OPTIONS.find(s => s.value === studio.sound)?.hint

  return (
    <div className="space-y-6">
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

          <Field className="min-w-[200px] flex-1 max-w-[240px]">
            <FieldLabel>Image model</FieldLabel>
            <Select
              value={studio.imageModel}
              onValueChange={v => {
                if (v === 'z_image' || v === 'seedream_edit') studio.setImageModel(v)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="z_image">{IMAGE_MODEL_LABEL.z_image}</SelectItem>
                <SelectItem value="seedream_edit">{IMAGE_MODEL_LABEL.seedream_edit}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {studio.imageModel === 'seedream_edit' && (
            <Field className="w-[100px]">
              <FieldLabel>Resolution</FieldLabel>
              <Select
                value={studio.seedreamResolution}
                onValueChange={v => {
                  if (v === '1k' || v === '2k') studio.setSeedreamResolution(v)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1k">1k</SelectItem>
                  <SelectItem value="2k">2k</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}

          <Field className="min-w-[220px] flex-1 max-w-[260px]">
            <FieldLabel>Video model</FieldLabel>
            <Select
              value={studio.videoBackend}
              onValueChange={v => {
                if (VIDEO_BACKEND_OPTIONS.some(o => o.value === v)) {
                  studio.setVideoBackend(v as VideoBackendChoice)
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VIDEO_BACKEND_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field className="min-w-[200px] flex-1 max-w-[240px]">
            <FieldLabel>Sound</FieldLabel>
            <Select
              value={studio.sound}
              onValueChange={v => {
                const opt = SOUND_OPTIONS.find(o => o.value === v)
                if (opt) studio.setSound(opt.value)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOUND_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="ml-auto flex flex-col items-end gap-1 pb-0.5">
            <span className="text-xs text-muted-foreground">Est. / video</span>
            <span className="text-lg font-semibold tabular-nums">
              {studio.formatUsd(avgEstimate.totalUsd)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              img {studio.formatUsd(avgEstimate.imageUsd)} · vid {studio.formatUsd(avgEstimate.videoUsd)}
              {avgEstimate.audioUsd > 0 ? ` · aud ${studio.formatUsd(avgEstimate.audioUsd)}` : ''}
            </span>
          </div>
        </div>

        <FieldHint>
          {studio.imageModel === 'z_image' ? 'Z-Image locks face via LoRA.' : 'Seedream edits layout from the source thumb + refs.'}
          {' '}
          {soundHint}
          {studio.sound === 'fish' ? ' Preference saved; Fish mux ships next.' : ''}
        </FieldHint>

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
                disabled={selected.size === 0 || !!working}
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
            No items in this queue. Approve posts in Discovery and bind a character to the tracked profile.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {items.map(item => {
            const est = studio.estimateFor(item.source_duration)
            const step = stepIndex(item.replicate_status)
            const summary = sceneSpecSummary(item.scene_spec)
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
                    <a
                      href={item.thumbnail_url || item.content_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 w-24 sm:w-28 aspect-[9/16] rounded-lg overflow-hidden bg-secondary/50 ring-1 ring-border/60"
                    >
                      {item.thumbnail_url || item.generated_image_url ? (
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

                    <div className="min-w-0 flex-1 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-base">@{item.profile}</span>
                            {item.content_type && (
                              <Badge variant="outline">{item.content_type}</Badge>
                            )}
                            {item.video_technique && (
                              <Badge variant="outline" className="border-primary/40 text-primary">
                                {TECHNIQUE_LABEL[item.video_technique] ?? item.video_technique}
                                {item.technique_confidence != null && (
                                  <span className="ml-1 opacity-60">
                                    {Math.round(item.technique_confidence * 100)}%
                                  </span>
                                )}
                              </Badge>
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
                            path{' '}
                            {IMAGE_MODEL_LABEL[studio.imageModel]} →{' '}
                            {VIDEO_BACKEND_OPTIONS.find(o => o.value === studio.videoBackend)?.label}
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
                        {(!item.content_type || !item.video_technique) && (
                          <Button
                            variant="outline"
                            disabled={working === item.id}
                            onClick={() => runAction(item.id, 'classify')}
                          >
                            {working === item.id
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <Sparkles className="w-4 h-4" />}
                            {item.content_type ? 'Detect technique' : 'Classify'}
                          </Button>
                        )}
                        {item.replicate_status !== 'done' && item.replicate_status !== 'skipped' && (
                          <Button
                            disabled={working === item.id}
                            onClick={() => {
                              studio.clearStop()
                              runAction(item.id, 'replicate')
                            }}
                          >
                            {working === item.id
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <Play className="w-4 h-4" />}
                            {item.replicate_status === 'needs_review' ? 'Replicate anyway' : 'Replicate'}
                          </Button>
                        )}
                        <Button variant="ghost" onClick={() => setDetailId(item.id)}>
                          <Eye className="w-4 h-4" />
                          Details
                        </Button>
                        {item.generated_image_url && (
                          <a
                            href={item.generated_image_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 text-sm text-primary px-2 py-1.5"
                          >
                            <ImageIcon className="w-4 h-4" /> Image
                          </a>
                        )}
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
        imageModelLabel={IMAGE_MODEL_LABEL[studio.imageModel as ImageModelChoice]}
        videoLabel={VIDEO_BACKEND_OPTIONS.find(o => o.value === studio.videoBackend)?.label ?? ''}
        soundLabel={SOUND_OPTIONS.find(o => o.value === studio.sound)?.label ?? ''}
        formatUsd={studio.formatUsd}
      />
    </div>
  )
}

/** @deprecated use RunTab — kept for any old imports */
export const ReplicateTab = RunTab
