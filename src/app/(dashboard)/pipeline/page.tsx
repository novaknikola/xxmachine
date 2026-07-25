'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  GitBranch,
  Plus,
  RefreshCw,
  Loader2,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  Film,
  Image,
} from 'lucide-react'

// ─── Types ──────────────────────────────────────────────────────────

interface PipelineJob {
  id: string
  source_url: string
  source_content_url?: string
  source_profile?: string
  motion_notes: string | null
  status: string
  prompt: string | null
  wavespeed_img_url: string | null
  wan_job_id: string | null
  output_url: string | null
  error: string | null
  created_at: string
  done_at: string | null
}

// ─── Status config ──────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof Loader2 }> = {
  PENDING:          { label: 'Pending',         color: 'bg-secondary text-muted-foreground',   icon: Clock },
  DOWNLOADING:      { label: 'Downloading',     color: 'bg-sky-500/15 text-sky-400',           icon: Loader2 },
  EXTRACTING_FRAME: { label: 'Extracting',      color: 'bg-indigo-500/15 text-indigo-400',     icon: Loader2 },
  ANALYZING:        { label: 'Analyzing (Grok)', color: 'bg-violet-500/15 text-violet-400',    icon: Loader2 },
  GENERATING_IMAGE: { label: 'Generating image', color: 'bg-pink-500/15 text-pink-400',       icon: Zap },
  ANIMATING:        { label: 'Animating (WAN)', color: 'bg-amber-500/15 text-amber-400',      icon: Film },
  DONE:             { label: 'Done',            color: 'bg-emerald-500/15 text-emerald-400',   icon: CheckCircle2 },
  FAILED:           { label: 'Error',           color: 'bg-destructive/15 text-destructive',   icon: XCircle },
}

const ACTIVE_STATUSES = ['DOWNLOADING', 'EXTRACTING_FRAME', 'ANALYZING', 'GENERATING_IMAGE', 'ANIMATING']

// ─── Job Card ────────────────────────────────────────────────────────

function JobCard({ job }: { job: PipelineJob }) {
  const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.PENDING
  const Icon = cfg.icon
  const isActive = ACTIVE_STATUSES.includes(job.status)

  return (
    <div className="rounded-xl border border-border/50 bg-secondary/20 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {job.source_profile && (
              <span className="text-sm font-medium">@{job.source_profile}</span>
            )}
            <span className="text-xs text-muted-foreground font-mono truncate max-w-[200px]">
              {job.id.slice(0, 8)}…
            </span>
          </div>
          {job.motion_notes && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{job.motion_notes}</p>
          )}
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex items-center gap-1 shrink-0 ${cfg.color}`}>
          <Icon className={`w-2.5 h-2.5 ${isActive ? 'animate-spin' : ''}`} />
          {cfg.label}
        </span>
      </div>

      {job.prompt && (
        <p className="text-xs text-muted-foreground bg-secondary/50 rounded-lg px-3 py-2 line-clamp-2 italic">
          "{job.prompt}"
        </p>
      )}

      <div className="flex items-center gap-3">
        <a
          href={job.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
        >
          <ExternalLink className="w-3 h-3" /> Izvor
        </a>
        {job.wavespeed_img_url && (
          <a
            href={job.wavespeed_img_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
          >
            <Image className="w-3 h-3" /> Tiana slika
          </a>
        )}
        {job.output_url && (
          <a
            href={job.output_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-medium transition-colors"
          >
            <Film className="w-3 h-3" /> Output video
          </a>
        )}
        <span className="text-xs text-muted-foreground/60 ml-auto">
          {new Date(job.created_at).toLocaleString('sr-Latn')}
        </span>
      </div>

      {job.error && (
        <div className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2 font-mono">
          {job.error.slice(0, 200)}
        </div>
      )}
    </div>
  )
}

// ─── Add Job Panel ───────────────────────────────────────────────────

function AddJobPanel({ onAdd }: { onAdd: (j: PipelineJob) => void }) {
  const [url, setUrl]     = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!url.trim()) return
    setSaving(true)
    try {
      const res = await fetch('/api/runpod/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_url: url.trim(), motion_notes: notes.trim() || null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onAdd(data.job)
      setUrl('')
      setNotes('')
      toast.success('Pipeline job created')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="glass-card rounded-2xl p-5 space-y-3">
      <h3 className="text-sm font-semibold">Manually add URL</h3>
      <div className="grid gap-2">
        <Input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://www.instagram.com/reel/..."
          className="bg-secondary/50"
        />
        <Input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Motion notes (optional)"
          className="bg-secondary/50"
        />
      </div>
      <Button size="sm" className="h-8 w-full" onClick={submit} disabled={saving || !url.trim()}>
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Plus className="w-3.5 h-3.5 mr-1.5" />}
        Add to pipeline
      </Button>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────

export default function PipelinePage() {
  const [jobs, setJobs]         = useState<PipelineJob[]>([])
  const [loading, setLoading]   = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const fetchJobs = useCallback(async () => {
    try {
      const res  = await fetch('/api/runpod/pipeline?limit=30')
      const data = await res.json()
      setJobs(data.jobs ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchJobs() }, [fetchJobs])

  // Auto-refresh every 10s if there are active jobs
  useEffect(() => {
    if (!autoRefresh) return
    const hasActive = jobs.some(j => ACTIVE_STATUSES.includes(j.status))
    if (!hasActive) return
    const t = setTimeout(() => fetchJobs(), 10_000)
    return () => clearTimeout(t)
  }, [jobs, autoRefresh, fetchJobs])

  const activeCount = jobs.filter(j => ACTIVE_STATUSES.includes(j.status)).length
  const doneCount   = jobs.filter(j => j.status === 'DONE').length
  const failedCount = jobs.filter(j => j.status === 'FAILED').length

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" /> Pipeline
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Real-time status of video generation
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="accent-primary"
            />
            Auto-refresh
          </label>
          <Button variant="outline" size="sm" className="h-8" onClick={fetchJobs}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="glass-card rounded-xl p-3 text-center">
          <p className="text-2xl font-bold text-amber-400">{activeCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Active</p>
        </div>
        <div className="glass-card rounded-xl p-3 text-center">
          <p className="text-2xl font-bold text-emerald-400">{doneCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Done</p>
        </div>
        <div className="glass-card rounded-xl p-3 text-center">
          <p className="text-2xl font-bold text-destructive">{failedCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Errors</p>
        </div>
      </div>

      {/* Add manually */}
      <AddJobPanel onAdd={j => setJobs(prev => [j, ...prev])} />

      {/* Jobs list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12">
          <GitBranch className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            No pipeline jobs. Approve a Reel in Discovery to start one.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  )
}
