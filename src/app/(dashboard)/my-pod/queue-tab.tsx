'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Loader2, CheckCircle2, XCircle, Clock, RefreshCw, Trash2, ListTodo, ExternalLink } from 'lucide-react'

interface RowOut {
  prompt?: string
  label?: string
  status: string
  stage?: string
  driveLink?: string
  error?: string
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
  input: { outputDriveFolderId?: string } | null
  created_at: string
}

const MY_POD_TYPES = new Set(['comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate', 'my_pod_talk'])

function typeLabel(t: string) {
  if (t === 'my_pod_talk') return 'Talk (Fish + InfiniteTalk)'
  if (t === 'my_pod_i2v') return 'WAN I2V'
  if (t === 'my_pod_animate') return 'WAN Animate'
  return 'Simple template'
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

export function QueueTab() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/queue/list')
      if (res.ok) {
        const data = await res.json()
        const all = (data.jobs ?? []) as Job[]
        setJobs(all.filter(j => MY_POD_TYPES.has(j.job_type)))
      }
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
        <p className="text-sm text-muted-foreground">My Pod jobs — results in your output Drive folder</p>
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
          <p className="text-xs mt-1 opacity-70">Submit from the Generate tab</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => {
            const rows = job.output?.myPodRows ?? job.output?.comfyuiRows ?? []
            const doneCount = rows.filter(r => r.status === 'done').length
            const errorCount = rows.filter(r => r.status === 'error' || r.status === 'failed').length
            const outputFolderId = job.input?.outputDriveFolderId
            const outputFolderLink = outputFolderId ? `https://drive.google.com/drive/folders/${outputFolderId}` : undefined
            const currentStage = job.output?.stage
              ?? rows.find(r => r.stage && r.status !== 'done' && r.status !== 'error')?.stage

            return (
              <div key={job.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{typeLabel(job.job_type)}</span>
                      <StatusBadge status={job.status} />
                      {currentStage && job.status === 'processing' && (
                        <span className="text-[10px] text-muted-foreground font-mono">{currentStage}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {new Date(job.created_at).toLocaleString()} · {job.total_items} item{job.total_items !== 1 ? 's' : ''}
                    </p>
                  </div>
                  {job.status === 'pending' && (
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => cancelJob(job.id)} title="Cancel">
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  )}
                </div>

                {(job.status === 'processing' || job.status === 'done') && job.total_items > 0 && (
                  <div className="space-y-1">
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
                  <div className="flex items-center gap-3 text-xs">
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
                  <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2 font-mono break-all">{job.error}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
