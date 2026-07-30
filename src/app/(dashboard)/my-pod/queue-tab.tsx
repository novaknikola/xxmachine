'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  Loader2, CheckCircle2, XCircle, Clock, RefreshCw, Trash2, ListTodo,
  ExternalLink, ChevronDown, ChevronRight,
} from 'lucide-react'

interface RowOut {
  prompt?: string
  label?: string
  status: string
  stage?: string
  driveLink?: string
  error?: string
}

interface JobInput {
  outputDriveFolderId?: string
  inputDriveFolderId?: string
  fishVoiceId?: string
  style?: string
  items?: unknown[]
  texts?: string[]
  itemCount?: number
  textCount?: number
}

interface Job {
  id: string
  job_type: string
  status: 'pending' | 'processing' | 'done' | 'failed' | 'cancelled'
  total_items: number
  done_items: number
  progress: number
  error: string | null
  output: {
    comfyuiRows?: RowOut[]
    myPodRows?: RowOut[]
    stage?: string
  } | null
  input: JobInput | null
  created_at: string
  started_at?: string | null
  pod_session_id?: string | null
  pod_name?: string | null
}

type RowFilter = 'all' | 'done' | 'failed'

const MY_POD_TYPES = new Set(['comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate', 'my_pod_talk'])

function typeLabel(t: string) {
  if (t === 'my_pod_talk') return 'InfiniteTalk'
  if (t === 'my_pod_i2v') return 'WAN I2V'
  if (t === 'my_pod_animate') return 'WAN Animate'
  return 'Simple template'
}

function driveFolderLink(id?: string) {
  return id ? `https://drive.google.com/drive/folders/${id}` : undefined
}

function StatusBadge({ status }: { status: Job['status'] }) {
  const cfg: Record<Job['status'], { label: string; cls: string; icon: React.ReactNode }> = {
    pending:    { label: 'Waiting',    cls: 'bg-secondary text-muted-foreground', icon: <Clock className="w-2.5 h-2.5" /> },
    processing: { label: 'Processing', cls: 'bg-blue-500/15 text-blue-400',       icon: <Loader2 className="w-2.5 h-2.5 animate-spin" /> },
    done:       { label: 'Done',       cls: 'bg-emerald-500/15 text-emerald-400', icon: <CheckCircle2 className="w-2.5 h-2.5" /> },
    failed:     { label: 'Error',      cls: 'bg-destructive/15 text-destructive', icon: <XCircle className="w-2.5 h-2.5" /> },
    cancelled:  { label: 'Cancelled',  cls: 'bg-secondary text-muted-foreground', icon: <XCircle className="w-2.5 h-2.5" /> },
  }
  const { label, cls, icon } = cfg[status]
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex items-center gap-1 shrink-0 ${cls}`}>
      {icon}{label}
    </span>
  )
}

function ItemStatus({ status }: { status: string }) {
  if (status === 'done') {
    return <span className="text-[10px] text-emerald-400 font-medium">done</span>
  }
  if (status === 'error' || status === 'failed') {
    return <span className="text-[10px] text-destructive font-medium">failed</span>
  }
  return <span className="text-[10px] text-muted-foreground font-medium">{status}</span>
}

function JobCard({
  job,
  expanded,
  onToggle,
  onCancel,
}: {
  job: Job
  expanded: boolean
  onToggle: () => void
  onCancel: () => void
}) {
  const [filter, setFilter] = useState<RowFilter>('all')
  const rows = job.output?.myPodRows ?? job.output?.comfyuiRows ?? []
  const doneCount = rows.filter(r => r.status === 'done').length
  const errorCount = rows.filter(r => r.status === 'error' || r.status === 'failed').length
  const outputFolderLink = driveFolderLink(job.input?.outputDriveFolderId)
  const inputFolderLink = driveFolderLink(job.input?.inputDriveFolderId)
  const currentStage = job.output?.stage
    ?? rows.find(r => r.stage && r.status !== 'done' && r.status !== 'error')?.stage
  const textCount = job.input?.texts?.length
    ?? job.input?.textCount
    ?? (Array.isArray(job.input?.items) ? job.input.items.length : undefined)
    ?? job.input?.itemCount

  const filtered = rows.filter(r => {
    if (filter === 'done') return r.status === 'done'
    if (filter === 'failed') return r.status === 'error' || r.status === 'failed'
    return true
  })

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={onToggle}
            className="mt-0.5 h-7 w-7 shrink-0 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary"
            aria-expanded={expanded}
            title={expanded ? 'Collapse' : 'Expand details'}
          >
            {expanded
              ? <ChevronDown className="w-4 h-4" />
              : <ChevronRight className="w-4 h-4" />}
          </button>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">{typeLabel(job.job_type)}</span>
              <StatusBadge status={job.status} />
              {currentStage && job.status === 'processing' && (
                <span className="text-[10px] text-muted-foreground font-mono">{currentStage}</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {new Date(job.created_at).toLocaleString()}
              {' · '}{job.total_items} item{job.total_items !== 1 ? 's' : ''}
              {job.pod_name ? ` · ${job.pod_name}` : ''}
            </p>
          </div>
          {job.status === 'pending' && (
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
              onClick={onCancel} title="Cancel">
              <Trash2 className="w-3 h-3" />
            </Button>
          )}
        </div>

        {(job.status === 'processing' || job.status === 'done') && job.total_items > 0 && (
          <div className="space-y-1 pl-9">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{job.done_items} / {job.total_items}</span>
              <span>{job.progress}%</span>
            </div>
            <div className="h-2 rounded-full bg-secondary overflow-hidden">
              <div className={`h-full transition-all duration-500 ${job.status === 'done' ? 'bg-emerald-500' : 'bg-primary animate-pulse'}`}
                style={{ width: `${job.progress}%` }} />
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="flex items-center gap-3 text-xs pl-9">
            <span className="text-emerald-400 font-medium">{doneCount} done</span>
            {errorCount > 0 && <span className="text-destructive">{errorCount} failed</span>}
            {outputFolderLink && (
              <a href={outputFolderLink} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-primary hover:underline">
                Open output folder <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        )}

        {job.error && job.status === 'failed' && (
          <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2 font-mono break-all ml-9">{job.error}</p>
        )}
      </div>

      {expanded && (
        <div className="border-t border-border bg-secondary/20 px-4 py-3 space-y-3 pl-[3.25rem]">
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <p>
              <span className="text-foreground/80">Job</span>{' '}
              <span className="font-mono">{job.id.slice(0, 8)}</span>
            </p>
            <p>
              <span className="text-foreground/80">Stage</span>{' '}
              <span className="font-mono">{currentStage ?? '—'}</span>
            </p>
            {job.started_at && (
              <p>
                <span className="text-foreground/80">Started</span>{' '}
                {new Date(job.started_at).toLocaleString()}
              </p>
            )}
            {job.job_type === 'my_pod_talk' && (
              <>
                {job.input?.fishVoiceId && (
                  <p className="sm:col-span-2">
                    <span className="text-foreground/80">FishVoiceID</span>{' '}
                    <span className="font-mono break-all">{job.input.fishVoiceId}</span>
                  </p>
                )}
                {job.input?.style && (
                  <p className="sm:col-span-2">
                    <span className="text-foreground/80">Style</span> {job.input.style}
                  </p>
                )}
                {textCount != null && (
                  <p>
                    <span className="text-foreground/80">Texts</span> {textCount}
                  </p>
                )}
              </>
            )}
            {inputFolderLink && (
              <a href={inputFolderLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                Input folder <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {outputFolderLink && (
              <a href={outputFolderLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                Output folder <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>

          {rows.length > 0 && (
            <>
              <div className="flex gap-1">
                {(['all', 'done', 'failed'] as const).map(f => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`text-[10px] px-2 py-1 rounded-md capitalize transition-colors ${
                      filter === f
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-secondary'
                    }`}
                  >
                    {f}
                    {f === 'failed' && errorCount > 0 ? ` (${errorCount})` : ''}
                    {f === 'done' ? ` (${doneCount})` : ''}
                    {f === 'all' ? ` (${rows.length})` : ''}
                  </button>
                ))}
              </div>

              <div className="max-h-72 overflow-y-auto rounded-lg border border-border divide-y divide-border bg-card">
                {filtered.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-3 py-4 text-center">No items in this filter</p>
                ) : (
                  filtered.map((row) => {
                    const n = rows.indexOf(row) + 1
                    const label = row.label || row.prompt || `item ${n}`
                    const isFail = row.status === 'error' || row.status === 'failed'
                    return (
                      <div
                        key={`${job.id}-${n}-${label}`}
                        className={`px-3 py-2 space-y-1 ${isFail ? 'bg-destructive/5' : ''}`}
                      >
                        <div className="flex items-center gap-2 text-xs min-w-0">
                          <span className="text-muted-foreground font-mono w-6 shrink-0">{n}</span>
                          <span className="truncate font-medium flex-1" title={label}>{label}</span>
                          <ItemStatus status={row.status} />
                          {row.stage && row.status !== 'done' && (
                            <span className="text-[10px] text-muted-foreground font-mono shrink-0">{row.stage}</span>
                          )}
                          {row.driveLink && (
                            <a
                              href={row.driveLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary shrink-0"
                              title="Open result"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                        {isFail && row.error && (
                          <p className="text-[11px] text-destructive font-mono break-all pl-8">{row.error}</p>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </>
          )}

          {rows.length === 0 && (
            <p className="text-xs text-muted-foreground">No item rows yet — waiting for the first clip to finish.</p>
          )}
        </div>
      )}
    </div>
  )
}

export function QueueTab() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/queue/list?scope=my-pod')
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(typeof data.error === 'string' ? data.error : 'Could not load queue')
        return
      }
      const data = await res.json()
      const all = (data.jobs ?? []) as Job[]
      setJobs(all.filter(j => MY_POD_TYPES.has(j.job_type)))
    } catch {
      toast.error('Could not load queue')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchJobs() }, [fetchJobs])

  useEffect(() => {
    const hasActive = jobs.some(j => j.status === 'pending' || j.status === 'processing')
    if (!hasActive) return
    const t = setTimeout(() => fetchJobs(), 5000)
    return () => clearTimeout(t)
  }, [jobs, fetchJobs])

  async function cancelJob(id: string) {
    const res = await fetch(`/api/queue/${id}`, { method: 'DELETE' })
    if (res.ok) { toast.success('Job cancelled'); fetchJobs() }
    else toast.error('Could not cancel job')
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">My Pod jobs — expand a batch for full item details</p>
        <Button variant="outline" size="sm" onClick={fetchJobs} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <ListTodo className="w-12 h-12 mx-auto mb-3 opacity-15" />
          <p className="text-sm font-medium">No My Pod jobs yet</p>
          <p className="text-xs mt-1 opacity-70">Submit from the Workflows tab</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              expanded={!!expanded[job.id]}
              onToggle={() => setExpanded(prev => ({ ...prev, [job.id]: !prev[job.id] }))}
              onCancel={() => cancelJob(job.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
