'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Pagination } from '@/components/ui/pagination'
import { CheckSquare, Loader2, RefreshCw, Search, Trash2, Wand2 } from 'lucide-react'
import { GenerationPanel } from './generation-panel'
import type { ScrapedPromptItem } from './browse-tab'

const PAGE_SIZE = 48

interface Board {
  id: string
  board_key: string
  owner: string
  slug: string
  title: string | null
  board_url: string
  pin_count: number
  synced_at: string | null
  last_error: string | null
}

interface Pin {
  id: string
  board_id: string
  pin_key: string
  pin_url: string | null
  title: string | null
  image_url: string
  image_url_hd: string
  board_title: string | null
  board_key: string
}

export function PinterestTab() {
  const [boards, setBoards] = useState<Board[]>([])
  const [boardId, setBoardId] = useState('')
  const [pins, setPins] = useState<Pin[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [boardUrl, setBoardUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [selected, setSelected] = useState<Map<string, Pin>>(new Map())
  const [panelOpen, setPanelOpen] = useState(false)

  const loadBoards = useCallback(async () => {
    const res = await fetch('/api/pinterest/boards')
    if (!res.ok) return
    const data = await res.json() as { boards: Board[] }
    setBoards(data.boards ?? [])
  }, [])

  const loadPins = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (boardId) params.set('boardId', boardId)
      if (search) params.set('q', search)
      const res = await fetch(`/api/pinterest/pins?${params}`)
      const data = await res.json() as { pins: Pin[]; total: number; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to load pins')
      setPins(data.pins ?? [])
      setTotal(data.total ?? 0)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load pins')
    } finally {
      setLoading(false)
    }
  }, [page, boardId, search])

  useEffect(() => { void loadBoards() }, [loadBoards])
  useEffect(() => { void loadPins() }, [loadPins])

  async function importBoard() {
    const url = boardUrl.trim()
    if (!url) { toast.error('Paste a Pinterest board URL'); return }
    setImporting(true)
    try {
      const res = await fetch('/api/pinterest/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await res.json() as { imported?: number; pinCount?: number; title?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Import failed')
      toast.success(`${data.title ?? 'Board'} — ${data.imported} pins read, ${data.pinCount} in library`)
      setBoardUrl('')
      await loadBoards()
      setPage(1)
      await loadPins()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  async function resync(board: Board) {
    setImporting(true)
    try {
      const res = await fetch('/api/pinterest/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: board.board_url }),
      })
      const data = await res.json() as { imported?: number; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Re-sync failed')
      toast.success(`${board.title ?? board.board_key} — ${data.imported} pins`)
      await loadBoards()
      await loadPins()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Re-sync failed')
    } finally {
      setImporting(false)
    }
  }

  async function removeBoard(board: Board) {
    const res = await fetch(`/api/pinterest/boards?id=${board.id}`, { method: 'DELETE' })
    if (!res.ok) { toast.error('Could not remove board'); return }
    if (boardId === board.id) setBoardId('')
    toast.success(`Removed ${board.title ?? board.board_key}`)
    await loadBoards()
    await loadPins()
  }

  function toggle(pin: Pin) {
    setSelected(prev => {
      const next = new Map(prev)
      if (next.has(pin.id)) next.delete(pin.id)
      else next.set(pin.id, pin)
      return next
    })
  }

  function selectPage() {
    setSelected(prev => {
      const next = new Map(prev)
      for (const p of pins) next.set(p.id, p)
      return next
    })
  }

  /**
   * Pins carry no prompt of their own — the panel detects that every item has a
   * sceneRefUrl and asks for one prompt to apply across the batch. The HD
   * variant is sent, never the grid thumbnail.
   */
  const selectedItems: ScrapedPromptItem[] = [...selected.values()].map(p => ({
    id: p.id,
    title: p.title,
    prompt: '',
    preview_image_url: p.image_url,
    media_urls: [],
    author: p.board_key,
    source_url: p.pin_url,
    has_template_args: false,
    sceneRefUrl: p.image_url_hd,
  }))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 border-b border-border px-5 py-3 space-y-3">
        <div className="flex gap-2">
          <Input
            value={boardUrl}
            onChange={e => setBoardUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void importBoard() }}
            placeholder="https://www.pinterest.com/<user>/<board>/ — paste a public board"
            className="text-sm"
          />
          <Button onClick={() => void importBoard()} disabled={importing} className="shrink-0">
            {importing ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1.5" />}
            Import
          </Button>
        </div>

        {boards.length > 0 && (
          <div className="flex gap-1.5 flex-wrap items-center">
            <button
              onClick={() => { setBoardId(''); setPage(1) }}
              className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${boardId === '' ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-secondary'}`}
            >
              All boards
            </button>
            {boards.map(b => (
              <div key={b.id} className="group flex items-center">
                <button
                  onClick={() => { setBoardId(b.id); setPage(1) }}
                  className={`px-2.5 py-1 rounded-l-md text-xs border border-r-0 transition-colors ${boardId === b.id ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-secondary'}`}
                  title={b.last_error ?? b.board_url}
                >
                  {b.title ?? b.board_key}
                  <span className="opacity-60"> · {b.pin_count}</span>
                </button>
                <button
                  onClick={() => void resync(b)}
                  disabled={importing}
                  className="px-1.5 py-1 border border-r-0 border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  title="Re-sync — picks up pins added since the last import"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
                <button
                  onClick={() => void removeBoard(b)}
                  className="px-1.5 py-1 rounded-r-md border border-border text-muted-foreground hover:text-destructive hover:bg-secondary transition-colors"
                  title="Remove board and its pins"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {boards.some(b => b.last_error) && (
          <p className="text-[11px] text-amber-400/80">
            {boards.filter(b => b.last_error).map(b => `${b.board_key}: ${b.last_error}`).join(' · ')}
          </p>
        )}

        <div className="flex gap-2 items-center">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { setSearch(q.trim()); setPage(1) } }}
              placeholder="Search imported pins by title or board"
              className="pl-8 text-sm"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => { setSearch(q.trim()); setPage(1) }}>Search</Button>
          <Button variant="ghost" size="sm" onClick={selectPage} disabled={!pins.length}>Select page</Button>
          <span className="text-xs text-muted-foreground shrink-0">{total} pins</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-[3/4] rounded-xl bg-secondary/40 animate-pulse" />
            ))}
          </div>
        ) : !pins.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Search className="w-12 h-12 opacity-10 mb-3" />
            <p className="text-sm">
              {boards.length ? 'No pins match' : 'Import a public Pinterest board to start'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {pins.map(pin => {
              const isSelected = selected.has(pin.id)
              return (
                <Card
                  key={pin.id}
                  size="sm"
                  className={`cursor-pointer overflow-hidden py-0 transition-colors ${isSelected ? 'ring-2 ring-primary' : 'hover:ring-1 hover:ring-border'}`}
                  onClick={() => toggle(pin)}
                >
                  {/* Same fixed-window treatment as the browse grid: the image is
                      out of flow so its intrinsic height cannot stretch the tile. */}
                  <div className="relative aspect-[3/4] shrink-0 bg-secondary/40">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/proxy-image?url=${encodeURIComponent(pin.image_url)}`}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                      loading="lazy"
                      onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                    />
                    <div
                      className={`absolute top-1.5 right-1.5 w-5 h-5 rounded-md border flex items-center justify-center ${isSelected ? 'bg-primary border-primary' : 'bg-black/40 border-white/40'}`}
                    >
                      {isSelected && <CheckSquare className="w-3.5 h-3.5 text-primary-foreground" />}
                    </div>
                    {!boardId && (
                      <Badge variant="secondary" className="absolute bottom-1.5 left-1.5 text-[9px] h-4 px-1.5 max-w-[85%] truncate">
                        {pin.board_title ?? pin.board_key}
                      </Badge>
                    )}
                  </div>
                  <CardContent className="p-2.5">
                    <p className="text-[10px] text-muted-foreground line-clamp-2 h-[26px]">
                      {pin.title || 'Untitled pin'}
                    </p>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} className="mt-6" />
      </div>

      {selected.size > 0 && (
        <div className="shrink-0 border-t border-border bg-background px-5 py-3 flex items-center gap-3">
          <p className="text-sm font-medium">{selected.size} selected</p>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Map())}>Clear</Button>
          <Button size="sm" className="ml-auto" onClick={() => setPanelOpen(true)}>
            <Wand2 className="w-4 h-4 mr-1.5" />
            Generate
          </Button>
        </div>
      )}

      <GenerationPanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        items={selectedItems}
        onSubmitted={() => { setSelected(new Map()); setPanelOpen(false) }}
      />
    </div>
  )
}
