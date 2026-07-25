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
  score: number
  replicate_status: string
  replicate_error: string | null
  scene_prompt: string | null
  generated_image_url: string | null
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
}

export function ReplicateTab() {
  const [items, setItems] = useState<ReplicateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'active' | 'pending' | 'done' | 'failed'>('active')
  const [working, setWorking] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/monitor/items?status=${filter}`)
      const data = await res.json()
      setItems(data.items ?? [])
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

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
          {(['active', 'pending', 'done', 'failed'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs rounded-lg capitalize transition-colors ${
                filter === f ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary'
              }`}
            >
              {f}
            </button>
          ))}
          <Button size="sm" variant="outline" className="h-8" onClick={load}>
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
                    <Badge variant="secondary" className="text-[10px]">
                      {STATUS_LABEL[item.replicate_status] ?? item.replicate_status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">score {Number(item.score).toFixed(1)}</span>
                  </div>
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
                {!item.content_type && (
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    disabled={working === item.id}
                    onClick={() => runAction(item.id, 'classify')}>
                    {working === item.id ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Sparkles className="w-3 h-3 mr-1" />}
                    Classify
                  </Button>
                )}
                {item.replicate_status !== 'done' && item.replicate_status !== 'skipped' && (
                  <Button size="sm" className="h-7 text-xs"
                    disabled={working === item.id}
                    onClick={() => runAction(item.id, 'replicate')}>
                    {working === item.id ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Play className="w-3 h-3 mr-1" />}
                    Replicate
                  </Button>
                )}
              </div>

              {(item.generated_image_url || item.kling_video_url) && (
                <div className="flex gap-3 flex-wrap pt-1">
                  {item.generated_image_url && (
                    <a href={item.generated_image_url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-xs text-primary">
                      <ImageIcon className="w-3.5 h-3.5" /> Generated image
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
