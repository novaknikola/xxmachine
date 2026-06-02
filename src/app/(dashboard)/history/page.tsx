'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  Download, Trash2, FolderDown, CheckSquare, Square,
  ImageIcon, Loader2, Filter, RefreshCw, CalendarDays,
} from 'lucide-react'
import { ScheduleModal } from '@/components/schedule-modal'

interface GenerationRecord {
  id: string
  kind: 'text2img' | 'wan_edit'
  character_id: string | null
  character_name: string | null
  prompt: string
  dimension: string | null
  batch: number
  image_urls: string[]
  user_id: string | null
  created_at: string
}

type FilterKind = 'all' | 'text2img' | 'wan_edit'

const KIND_LABEL: Record<string, string> = {
  text2img: 'Image Generate',
  wan_edit: 'WAN Edit',
}

function groupByDate(records: GenerationRecord[]) {
  const map = new Map<string, GenerationRecord[]>()
  for (const r of records) {
    const date = new Date(r.created_at).toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    })
    if (!map.has(date)) map.set(date, [])
    map.get(date)!.push(r)
  }
  return Array.from(map.entries()).map(([date, records]) => ({ date, records }))
}

export default function HistoryPage() {
  const { user } = useAuth()
  const [records, setRecords] = useState<GenerationRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<FilterKind>('all')
  const [zipping, setZipping] = useState(false)
  const [scheduleModal, setScheduleModal] = useState<{ urls: string[]; characterId?: string; characterName?: string } | null>(null)
  const [offset, setOffset] = useState(0)
  const LIMIT = 100

  async function load(reset = false) {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (user?.id) params.set('userId', user.id)
      if (filter !== 'all') params.set('kind', filter)
      params.set('limit', String(LIMIT))
      params.set('offset', String(reset ? 0 : offset))

      const res = await fetch(`/api/generations?${params}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      if (reset) {
        setRecords(data.generations)
        setOffset(LIMIT)
      } else {
        setRecords(prev => [...prev, ...data.generations])
        setOffset(o => o + LIMIT)
      }
      setTotal(data.total)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (user) { setOffset(0); load(true) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, filter])

  const allUrls = useMemo(() => records.flatMap(r => r.image_urls), [records])

  function toggleUrl(url: string) {
    setSelected(prev => { const n = new Set(prev); n.has(url) ? n.delete(url) : n.add(url); return n })
  }

  function toggleRecord(r: GenerationRecord) {
    const allSel = r.image_urls.every(u => selected.has(u))
    setSelected(prev => {
      const n = new Set(prev)
      if (allSel) r.image_urls.forEach(u => n.delete(u))
      else r.image_urls.forEach(u => n.add(u))
      return n
    })
  }

  async function downloadZip(urls: string[], filename: string) {
    if (!urls.length) { toast.error('No images selected'); return }
    setZipping(true)
    try {
      const JSZipMod = (await import('jszip')).default
      const zip = new JSZipMod()
      await Promise.all(urls.map(async (url, i) => {
        try {
          const blob = await fetch(url).then(r => r.blob())
          const ext = blob.type.includes('png') ? 'png' : 'jpg'
          zip.file(`${String(i + 1).padStart(4, '0')}.${ext}`, blob)
        } catch {}
      }))
      const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(content)
      a.download = filename
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success(`Downloaded ${urls.length} images`)
    } catch { toast.error('ZIP failed') }
    finally { setZipping(false) }
  }

  async function deleteRecord(id: string) {
    const r = records.find(x => x.id === id)
    if (r) r.image_urls.forEach(u => setSelected(prev => { const n = new Set(prev); n.delete(u); return n }))
    await fetch('/api/generations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    setRecords(prev => prev.filter(x => x.id !== id))
    setTotal(t => t - 1)
  }

  const groups = useMemo(() => groupByDate(records), [records])
  const selectedList = Array.from(selected)
  const hasMore = records.length < total

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/15 border border-primary/25">
            <ImageIcon className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">Generation History</h1>
            <p className="text-xs text-muted-foreground">{total} generations · {allUrls.length} loaded</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Filter */}
          <div className="flex rounded-lg border border-border overflow-hidden text-xs">
            {(['all', 'text2img', 'wan_edit'] as FilterKind[]).map(k => (
              <button key={k} onClick={() => setFilter(k)}
                className={`px-3 py-1.5 font-medium transition-colors flex items-center gap-1 ${filter === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}>
                <Filter className="w-3 h-3" />
                {k === 'all' ? 'All' : KIND_LABEL[k]}
              </button>
            ))}
          </div>

          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={() => load(true)}>
            <RefreshCw className="w-3 h-3" />Refresh
          </Button>

          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5"
            onClick={() => selected.size === allUrls.length ? setSelected(new Set()) : setSelected(new Set(allUrls))}>
            {selected.size === allUrls.length
              ? <><Square className="w-3 h-3" />Deselect all</>
              : <><CheckSquare className="w-3 h-3" />Select all</>}
          </Button>

          {selectedList.length > 0 && (
            <Button size="sm" className="h-8 text-xs gap-1.5" disabled={zipping}
              onClick={() => downloadZip(selectedList, `history_selected_${new Date().toISOString().slice(0, 10)}.zip`)}>
              {zipping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              Download {selectedList.length}
            </Button>
          )}

          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" disabled={zipping || !allUrls.length}
            onClick={() => downloadZip(allUrls, `history_all_${new Date().toISOString().slice(0, 10)}.zip`)}>
            {zipping ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderDown className="w-3 h-3" />}
            Download all
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading && records.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin mr-2" />Loading history...
          </div>
        ) : records.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <ImageIcon className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm">No generations yet.</p>
            <p className="text-xs opacity-60 mt-1">Images appear here automatically after generation.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {groups.map(group => (
              <div key={group.date}>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">{group.date}</p>
                <div className="space-y-3">
                  {group.records.map(r => {
                    const allRowSel = r.image_urls.every(u => selected.has(u))
                    const someRowSel = r.image_urls.some(u => selected.has(u))
                    return (
                      <div key={r.id}
                        className="flex gap-4 p-4 rounded-xl border border-border bg-card hover:border-border/80 transition-colors group">
                        <button className="shrink-0 mt-1" onClick={() => toggleRecord(r)}>
                          {allRowSel
                            ? <CheckSquare className="w-4 h-4 text-primary" />
                            : someRowSel
                              ? <CheckSquare className="w-4 h-4 text-primary/50" />
                              : <Square className="w-4 h-4 text-muted-foreground/40" />}
                        </button>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                            {r.character_name && (
                              <span className="text-sm font-medium text-primary">{r.character_name}</span>
                            )}
                            {r.dimension && (
                              <Badge variant="outline" className="text-[10px] h-4 px-1">{r.dimension}</Badge>
                            )}
                            <Badge variant="secondary" className="text-[10px] h-4 px-1">{KIND_LABEL[r.kind] ?? r.kind}</Badge>
                            <span className="text-[10px] text-muted-foreground ml-auto">
                              {new Date(r.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{r.prompt}</p>

                          <div className="flex gap-2 flex-wrap">
                            {r.image_urls.map((url, i) => {
                              const isSel = selected.has(url)
                              return (
                                <div key={i} className="relative group/img cursor-pointer" onClick={() => toggleUrl(url)}>
                                  <div className={`w-20 h-20 rounded-lg overflow-hidden border-2 transition-all ${isSel ? 'border-primary' : 'border-transparent opacity-80 hover:opacity-100'}`}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={url} alt="" className="w-full h-full object-cover" />
                                  </div>
                                  {isSel && (
                                    <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                                      <CheckSquare className="w-2.5 h-2.5 text-primary-foreground" />
                                    </div>
                                  )}
                                  <a href={url} download={`image_${i + 1}.jpg`}
                                    onClick={e => e.stopPropagation()}
                                    className="absolute bottom-1 left-1 w-5 h-5 rounded bg-black/60 text-white opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center">
                                    <Download className="w-2.5 h-2.5" />
                                  </a>
                                </div>
                              )
                            })}
                          </div>
                        </div>

                        <div className="flex flex-col gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => setScheduleModal({ urls: r.image_urls, characterId: r.character_id ?? undefined, characterName: r.character_name ?? undefined })}
                            className="text-muted-foreground hover:text-primary transition-colors"
                            title="Schedule this post">
                            <CalendarDays className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => deleteRecord(r.id)}
                            className="text-muted-foreground hover:text-destructive transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}

            {hasMore && (
              <div className="flex justify-center pt-2">
                <Button variant="outline" onClick={() => load(false)} disabled={loading}>
                  {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Load more ({total - records.length} remaining)
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      {scheduleModal && (
        <ScheduleModal
          open={!!scheduleModal}
          onClose={() => setScheduleModal(null)}
          imageUrls={scheduleModal.urls}
          characterId={scheduleModal.characterId}
          characterName={scheduleModal.characterName}
        />
      )}
    </div>
  )
}
