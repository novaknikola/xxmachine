'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Pagination } from '@/components/ui/pagination'
import { ImageOff, Loader2, RefreshCw } from 'lucide-react'

interface CopyPromptsRow {
  promptId: string
  prompt: string
  images: string[]
  status: 'done' | 'error'
  error?: string
}

interface QueueJob {
  id: string
  job_type: string
  status: string
  progress: number
  total_items: number
  done_items: number
  created_at: string
  output?: { copyPromptsRows?: CopyPromptsRow[] } | null
}

const RESULTS_PAGE_SIZE = 12

function JobResultsGrid({ rows }: { rows: CopyPromptsRow[] }) {
  const [page, setPage] = useState(1)
  const allImages = rows.flatMap(r => r.images.map(url => ({ url })))
  const errorRows = rows.filter(r => r.status === 'error')
  const start = (page - 1) * RESULTS_PAGE_SIZE
  const pageItems = allImages.slice(start, start + RESULTS_PAGE_SIZE)

  return (
    <div className="space-y-3 pt-3">
      {pageItems.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {pageItems.map((img, i) => (
            <a
              key={`${img.url}-${i}`}
              href={img.url}
              target="_blank"
              rel="noreferrer"
              className="relative aspect-square rounded-lg overflow-hidden border border-border block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
            </a>
          ))}
        </div>
      )}
      {allImages.length === 0 && errorRows.length === 0 && (
        <p className="text-xs text-muted-foreground">No images yet.</p>
      )}
      {errorRows.length > 0 && (
        <div className="space-y-1">
          {errorRows.map((r, i) => (
            <p key={i} className="text-[11px] text-destructive flex items-center gap-1.5">
              <ImageOff className="w-3 h-3 shrink-0" /> {r.error ?? 'failed'}
            </p>
          ))}
        </div>
      )}
      <Pagination page={page} pageSize={RESULTS_PAGE_SIZE} total={allImages.length} onPageChange={setPage} />
    </div>
  )
}

function JobCard({ job, onRefresh }: { job: QueueJob; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const rows = job.output?.copyPromptsRows ?? []
  const running = job.status === 'pending' || job.status === 'processing'

  useEffect(() => {
    if (!running || !expanded) return
    const t = setInterval(onRefresh, 4000)
    return () => clearInterval(t)
  }, [running, expanded, onRefresh])

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Copy Prompts batch</p>
          <p className="text-xs text-muted-foreground">
            {new Date(job.created_at).toLocaleString()} · {job.done_items}/{job.total_items} done
          </p>
        </div>
        <Badge variant={job.status === 'done' ? 'default' : job.status === 'failed' ? 'destructive' : 'secondary'}>
          {job.status}
        </Badge>
        <Button variant="outline" size="sm" onClick={() => setExpanded(v => !v)}>
          {expanded ? 'Hide' : 'View'}
        </Button>
      </div>
      {running && (
        <div className="w-full bg-secondary rounded-full h-1.5">
          <div className="bg-primary h-1.5 rounded-full transition-all duration-300" style={{ width: `${job.progress}%` }} />
        </div>
      )}
      {expanded && <JobResultsGrid rows={rows} />}
    </div>
  )
}

const JOBS_PAGE_SIZE = 10

export function BatchesTab() {
  const [jobs, setJobs] = useState<QueueJob[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/queue/list')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load batches')
      const all: QueueJob[] = Array.isArray(data.jobs) ? data.jobs : []
      setJobs(all.filter(j => j.job_type === 'copy_prompts_generate'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load batches')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const start = (page - 1) * JOBS_PAGE_SIZE
  const pageJobs = jobs.slice(start, start + JOBS_PAGE_SIZE)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
        <p className="text-sm text-muted-foreground">{jobs.length} batch{jobs.length === 1 ? '' : 'es'}</p>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-5 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
          </div>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-12">
            No batches yet — generate from the Browse tab.
          </p>
        ) : (
          <>
            {pageJobs.map(job => <JobCard key={job.id} job={job} onRefresh={load} />)}
            <Pagination page={page} pageSize={JOBS_PAGE_SIZE} total={jobs.length} onPageChange={setPage} className="pt-2" />
          </>
        )}
      </div>
    </div>
  )
}
