'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Loader2, Play, RefreshCw, CheckCircle2, XCircle, ExternalLink,
  ImageIcon, Video, Sparkles,
} from 'lucide-react'

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
  score: number
  replicate_status: string
  replicate_error: string | null
  scene_prompt: string | null
  generated_image_url: string | null
  generated_end_image_url: string | null
  kling_video_url: string | null
  thumbnail_url: string | null
  discovered_at: string
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

const FILTERS = ['active', 'pending', 'review', 'done', 'failed'] as const
type Filter = typeof FILTERS[number]

export function ReplicateTab() {
  const [items, setItems] = useState<ReplicateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('active')
  const [working, setWorking] = useState<string | null>(null)

  // Nothing is set before the first await, so switching filters does not trigger a
  // cascading render from inside the effect below.
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

  async function runAction(id: string, action: 'classify' | 'replicate') {
    setWorking(id)
    try {
      const res = await fetch(`/api/monitor/${action}/${id}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(action === 'classify' ? 'Classified' : 'Replication complete')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm text-muted-foreground">
            Approved Discovery posts queued for copy-paste replication with your character&apos;s LoRA.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {FILTERS.map(f => (
            <button
              key={f}
              onClick={() => { setLoading(true); setFilter(f) }}
              className={`px-3 py-1.5 text-xs rounded-lg capitalize transition-colors ${
                filter === f ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary'
              }`}
            >
              {f}
            </button>
          ))}
          <Button size="sm" variant="outline" className="h-8" onClick={reload}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          No items in this queue. Approve posts in Discovery (Social Media) and bind a character to the tracked profile.
        </div>
      ) : (
        <div className="grid gap-3">
          {items.map(item => (
            <div key={item.id} className="rounded-xl border border-border/50 bg-secondary/20 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">@{item.profile}</span>
                    {item.content_type && (
                      <Badge variant="outline" className="text-[10px]">{item.content_type}</Badge>
                    )}
                    {item.video_technique && (
                      <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">
                        {TECHNIQUE_LABEL[item.video_technique] ?? item.video_technique}
                        {item.technique_confidence != null && (
                          <span className="ml-1 opacity-60">
                            {Math.round(item.technique_confidence * 100)}%
                          </span>
                        )}
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-[10px]">
                      {STATUS_LABEL[item.replicate_status] ?? item.replicate_status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">score {Number(item.score).toFixed(1)}</span>
                  </div>

                  {(item.source_duration != null || item.source_cut_count != null) && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {item.source_duration != null && `${Number(item.source_duration).toFixed(1)}s source`}
                      {item.source_duration != null && item.source_cut_count != null && ' · '}
                      {item.source_cut_count != null && (
                        item.source_cut_count === 0
                          ? 'one continuous shot'
                          : `${item.source_cut_count} cut${item.source_cut_count === 1 ? '' : 's'}`
                      )}
                      {item.video_model && ` · ${item.video_model}`}
                    </p>
                  )}

                  {item.technique_reasoning && (
                    <p className="text-[11px] text-muted-foreground/80 mt-1 italic">
                      {item.technique_reasoning}
                    </p>
                  )}

                  {item.replicate_error && (
                    <p className="text-xs text-destructive mt-1">{item.replicate_error}</p>
                  )}
                </div>
                <a href={item.content_url} target="_blank" rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground shrink-0">
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>

              <div className="flex gap-2 flex-wrap">
                {(!item.content_type || !item.video_technique) && (
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    disabled={working === item.id}
                    onClick={() => runAction(item.id, 'classify')}>
                    {working === item.id ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Sparkles className="w-3 h-3 mr-1" />}
                    {item.content_type ? 'Detect technique' : 'Classify'}
                  </Button>
                )}
                {item.replicate_status !== 'done' && item.replicate_status !== 'skipped' && (
                  <Button size="sm" className="h-7 text-xs"
                    disabled={working === item.id}
                    onClick={() => runAction(item.id, 'replicate')}>
                    {working === item.id ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Play className="w-3 h-3 mr-1" />}
                    {item.replicate_status === 'needs_review' ? 'Replicate anyway' : 'Replicate'}
                  </Button>
                )}
              </div>

              {(item.generated_image_url || item.kling_video_url) && (
                <div className="flex gap-3 flex-wrap pt-1">
                  {item.generated_image_url && (
                    <a href={item.generated_image_url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-xs text-primary">
                      <ImageIcon className="w-3.5 h-3.5" />
                      {item.generated_end_image_url ? 'First frame' : 'Generated image'}
                    </a>
                  )}
                  {item.generated_end_image_url && (
                    <a href={item.generated_end_image_url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-xs text-primary">
                      <ImageIcon className="w-3.5 h-3.5" /> Last frame
                    </a>
                  )}
                  {item.kling_video_url && (
                    <a href={item.kling_video_url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-xs text-primary">
                      <Video className="w-3.5 h-3.5" /> Generated video
                    </a>
                  )}
                  {item.replicate_status === 'done' && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  )}
                  {item.replicate_status === 'failed' && (
                    <XCircle className="w-4 h-4 text-destructive" />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
