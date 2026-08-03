'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Pagination } from '@/components/ui/pagination'
import { ImageOff, Loader2, RefreshCw, Square } from 'lucide-react'

interface CopyPromptsRow {
  promptId: string
  /** Prompt sent for the base slide — the Seedream edit itself. */
  prompt: string
  /** Prompt behind each extra carousel slide, index-aligned with images[1..]. */
  variantPrompts?: string[]
  /** Reference images this item was generated from, in the order sent. */
  referenceImageUrls?: string[]
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

/**
 * A route that dies before writing a body — a database connect timeout, say —
 * answers 500 with zero bytes, and res.json() then throws "Unexpected end of
 * JSON input", which says nothing about what went wrong. Report the status
 * instead.
 */
async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (!text) {
    throw new Error(res.ok ? 'Server returned an empty response' : `Server error (${res.status})`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Unexpected response from server (${res.status})`)
  }
}

/**
 * Images grouped by the item that produced them, so each slide sits under the
 * prompt that made it. Slide 1 is the Seedream edit from the references; the
 * rest are carousel variants, whose prompts come from a preset or from Grok and
 * were previously invisible — which is exactly where a batch goes wrong.
 */
function RowResult({ row, index }: { row: CopyPromptsRow; index: number }) {
  const [showPrompts, setShowPrompts] = useState(false)

  function promptFor(slide: number): string {
    return slide === 0 ? row.prompt : row.variantPrompts?.[slide - 1] ?? '(variant prompt not recorded)'
  }

  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-medium text-muted-foreground shrink-0">#{index + 1}</p>
        <p className="text-[11px] text-muted-foreground/80 truncate flex-1" title={row.prompt}>
          {row.prompt}
        </p>
        <Button variant="ghost" size="sm" className="h-6 text-[10px] shrink-0"
          onClick={() => setShowPrompts(v => !v)}>
          {showPrompts ? 'Hide prompts' : 'Prompts'}
        </Button>
      </div>

      {showPrompts && (
        <div className="space-y-2 rounded-md bg-secondary/40 p-2.5">
          <div>
            <p className="text-[10px] font-medium text-muted-foreground mb-0.5">
              Slide 1 — Seedream v5 Edit
            </p>
            <p className="text-[10px] font-mono whitespace-pre-wrap break-words">{row.prompt}</p>
          </div>
          {(row.variantPrompts ?? []).map((p, i) => (
            <div key={i}>
              <p className="text-[10px] font-medium text-muted-foreground mb-0.5">
                Slide {i + 2} — carousel variant
              </p>
              <p className="text-[10px] font-mono whitespace-pre-wrap break-words">{p}</p>
            </div>
          ))}
          {row.referenceImageUrls?.length ? (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground mb-1">
                References sent ({row.referenceImageUrls.length}, in order)
              </p>
              <div className="flex gap-1.5 flex-wrap">
                {row.referenceImageUrls.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noreferrer"
                    className="relative w-10 h-10 rounded overflow-hidden border border-border block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/proxy-image?url=${encodeURIComponent(url)}`} alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                      onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
                  </a>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
        {row.images.map((url, i) => (
          <a key={`${url}-${i}`} href={url} target="_blank" rel="noreferrer"
            title={promptFor(i)}
            className="relative aspect-square rounded-lg overflow-hidden border border-border block group/slide">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="absolute inset-0 w-full h-full object-cover" />
            <span className="absolute bottom-1 left-1 px-1 rounded bg-black/70 text-[9px] text-white">
              {i === 0 ? 'base' : `v${i}`}
            </span>
          </a>
        ))}
      </div>

      {row.status === 'error' && (
        <p className="text-[11px] text-destructive flex items-center gap-1.5">
          <ImageOff className="w-3 h-3 shrink-0" /> {row.error ?? 'failed'}
        </p>
      )}
    </div>
  )
}

function JobResultsGrid({ rows }: { rows: CopyPromptsRow[] }) {
  const [page, setPage] = useState(1)
  const start = (page - 1) * RESULTS_PAGE_SIZE
  const pageRows = rows.slice(start, start + RESULTS_PAGE_SIZE)

  if (!rows.length) {
    return <p className="text-xs text-muted-foreground pt-3">No images yet.</p>
  }

  return (
    <div className="space-y-3 pt-3">
      {pageRows.map((row, i) => (
        <RowResult key={row.promptId + i} row={row} index={start + i} />
      ))}
      <Pagination page={page} pageSize={RESULTS_PAGE_SIZE} total={rows.length} onPageChange={setPage} />
    </div>
  )
}

function JobCard({ job, onRefresh }: { job: QueueJob; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [live, setLive] = useState<QueueJob | null>(null)
  const shown = live ?? job
  const rows = shown.output?.copyPromptsRows ?? []
  const running = shown.status === 'pending' || shown.status === 'processing'

  // Poll this one job rather than the whole list: /api/queue/list returns 50
  // jobs with their full output, which is a lot of rows and a lot of database
  // work to repeat every 4 seconds just to advance one progress bar.
  useEffect(() => {
    if (!running || !expanded) return
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/queue/${job.id}`)
        if (!res.ok) return
        const data = await readJson<{ job?: QueueJob }>(res)
        if (!cancelled && data.job) setLive(data.job)
      } catch {
        // A dropped poll is not worth surfacing; the next tick retries.
      }
    }
    const t = setInterval(tick, 4000)
    return () => { cancelled = true; clearInterval(t) }
  }, [running, expanded, job.id])

  // Once it stops running, fold the final state back into the list.
  useEffect(() => {
    if (live && !running) onRefresh()
  }, [live, running, onRefresh])

  /**
   * The worker checks for this between batches, so the items already in flight
   * finish and everything generated so far stays in the batch — it stops the
   * spending, it does not throw away paid work.
   */
  async function stop() {
    setStopping(true)
    try {
      const res = await fetch(`/api/queue/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      })
      const data = await readJson<{ error?: string }>(res)
      if (!res.ok) throw new Error(data.error ?? 'Could not stop batch')
      toast.success('Stopping — the batch in flight finishes, then it halts')
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not stop batch')
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Copy Prompts batch</p>
          <p className="text-xs text-muted-foreground">
            {new Date(shown.created_at).toLocaleString()} · {shown.done_items}/{shown.total_items} done
          </p>
        </div>
        <Badge variant={shown.status === 'done' ? 'default' : shown.status === 'failed' ? 'destructive' : 'secondary'}>
          {shown.status}
        </Badge>
        {running && (
          <Button variant="destructive" size="sm" onClick={() => void stop()} disabled={stopping}>
            {stopping ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Square className="w-3.5 h-3.5 mr-1.5" />}
            Stop
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setExpanded(v => !v)}>
          {expanded ? 'Hide' : 'View'}
        </Button>
      </div>
      {running && (
        <div className="w-full bg-secondary rounded-full h-1.5">
          <div className="bg-primary h-1.5 rounded-full transition-all duration-300" style={{ width: `${shown.progress}%` }} />
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
      const data = await readJson<{ jobs?: QueueJob[]; error?: string }>(res)
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
