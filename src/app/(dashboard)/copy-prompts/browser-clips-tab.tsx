'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Pagination } from '@/components/ui/pagination'
import { BookImage, CheckSquare, Loader2, Puzzle, RefreshCw, Search, Trash2, Wand2 } from 'lucide-react'
import { GenerationPanel } from './generation-panel'
import type { ScrapedPromptItem } from './browse-tab'

const PAGE_SIZE = 48

interface Clip {
  id: string
  pin_key: string
  pin_url: string | null
  title: string | null
  image_url: string
  image_url_hd: string
}

interface Folder {
  id: string
  board_key: string
  title: string | null
  pin_count: number
}

/**
 * Images saved through the XXmachine Clipper browser extension (hover any
 * image on any site, or right-click → "Sačuvaj sliku u XXmachine", or grab a
 * whole page's images at once into a named folder). Same underlying
 * pinterest_pins storage as the Pinterest tab, but kept on its own tab per
 * the user's request — clips should not show up mixed into Pinterest.
 */
export function BrowserClipsTab() {
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderId, setFolderId] = useState('')
  const [clips, setClips] = useState<Clip[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Map<string, Clip>>(new Map())
  const [panelOpen, setPanelOpen] = useState(false)
  const [storyFolder, setStoryFolder] = useState('')
  const [savingStories, setSavingStories] = useState(false)

  const loadFolders = useCallback(async () => {
    const res = await fetch('/api/pinterest/browser-clips/folders')
    if (!res.ok) return
    const data = await res.json() as { folders: Folder[] }
    setFolders(data.folders ?? [])
  }, [])

  const loadClips = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (search) params.set('q', search)
      if (folderId) params.set('boardId', folderId)
      const res = await fetch(`/api/pinterest/browser-clips?${params}`)
      const data = await res.json() as { pins: Clip[]; total: number; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to load clips')
      setClips(data.pins ?? [])
      setTotal(data.total ?? 0)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load clips')
    } finally {
      setLoading(false)
    }
  }, [page, search, folderId])

  useEffect(() => { void loadFolders() }, [loadFolders])
  useEffect(() => { void loadClips() }, [loadClips])

  /** Flagged inactive, not deleted — same convention as the Pinterest tab's removePins. */
  async function removeClips(ids: string[]) {
    const res = await fetch('/api/pinterest/pins', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (!res.ok) { toast.error('Could not remove'); return }
    const data = await res.json() as { removed: number }
    setSelected(prev => {
      const next = new Map(prev)
      for (const id of ids) next.delete(id)
      return next
    })
    toast.success(`Removed ${data.removed} image${data.removed === 1 ? '' : 's'}`)
    await loadClips()
    await loadFolders()
  }

  async function saveToStories() {
    const folder = storyFolder.trim()
    if (!folder) { toast.error('Enter a Drive folder name for the stories'); return }
    setSavingStories(true)
    try {
      const res = await fetch('/api/pinterest/stories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected.keys()], folderName: folder }),
      })
      const data = await res.json() as {
        saved?: number; skipped?: number; archiveSkippedReason?: string | null; error?: string
      }
      if (!res.ok) throw new Error(data.error ?? 'Save failed')

      if (data.archiveSkippedReason) {
        toast.warning(`Repurposed ${data.saved}, but Drive did not take them (${data.archiveSkippedReason})`)
      } else {
        toast.success(`${data.saved} saved to stories${data.skipped ? ` · ${data.skipped} skipped` : ''}`)
      }
      setSelected(new Map())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSavingStories(false)
    }
  }

  function toggle(clip: Clip) {
    setSelected(prev => {
      const next = new Map(prev)
      if (next.has(clip.id)) next.delete(clip.id)
      else next.set(clip.id, clip)
      return next
    })
  }

  function selectPage() {
    setSelected(prev => {
      const next = new Map(prev)
      for (const c of clips) next.set(c.id, c)
      return next
    })
  }

  const selectedItems: ScrapedPromptItem[] = [...selected.values()].map(c => ({
    id: c.id,
    title: c.title,
    prompt: '',
    preview_image_url: c.image_url,
    media_urls: [],
    author: 'browser-clip',
    source_url: c.pin_url,
    has_template_args: false,
    sceneRefUrl: c.image_url_hd,
  }))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 border-b border-border px-5 py-3 space-y-3">
        {folders.length > 1 && (
          <div className="flex gap-1.5 flex-wrap items-center">
            <button
              onClick={() => { setFolderId(''); setPage(1) }}
              className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${folderId === '' ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-secondary'}`}
            >
              All folders
            </button>
            {folders.map(f => (
              <button
                key={f.id}
                onClick={() => { setFolderId(f.id); setPage(1) }}
                className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${folderId === f.id ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-secondary'}`}
              >
                {f.title ?? f.board_key}
                <span className="opacity-60"> · {f.pin_count}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-center">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { setSearch(q.trim()); setPage(1) } }}
              placeholder="Search clipped images by title"
              className="pl-8 text-sm"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => { setSearch(q.trim()); setPage(1) }}>Search</Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void loadFolders(); void loadClips() }}
            title="Refresh — picks up new clips saved from the extension"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={selectPage} disabled={!clips.length}>Select page</Button>
          <span className="text-xs text-muted-foreground shrink-0">{total} images</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-[3/4] rounded-xl bg-secondary/40 animate-pulse" />
            ))}
          </div>
        ) : !clips.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground text-center px-6">
            <Puzzle className="w-12 h-12 opacity-10 mb-3" />
            <p className="text-sm">No clipped images yet.</p>
            <p className="text-xs mt-1.5 max-w-sm">
              Install the XXmachine Clipper extension, pair it with a token from{' '}
              <a href="/settings" className="text-primary hover:underline">Settings → Content Engine</a>,
              then hover any image on any site and click the save button — or right-click it.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {clips.map(clip => {
              const isSelected = selected.has(clip.id)
              return (
                <Card
                  key={clip.id}
                  size="sm"
                  className={`group cursor-pointer overflow-hidden py-0 transition-colors ${isSelected ? 'ring-2 ring-primary' : 'hover:ring-1 hover:ring-border'}`}
                  onClick={() => toggle(clip)}
                >
                  <div className="relative aspect-[3/4] shrink-0 bg-secondary/40">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/proxy-image?url=${encodeURIComponent(clip.image_url)}`}
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
                    <button
                      title="Remove this image"
                      onClick={e => { e.stopPropagation(); void removeClips([clip.id]) }}
                      className="absolute top-1.5 left-1.5 w-5 h-5 rounded-md bg-black/60 text-white/80 hover:bg-destructive hover:text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  <CardContent className="p-2.5">
                    <p className="text-[10px] text-muted-foreground line-clamp-2 h-[26px]">
                      {clip.title || 'Untitled'}
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
        <div className="shrink-0 border-t border-border bg-background px-5 py-3 flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium">{selected.size} selected</p>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Map())}>Clear</Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => void removeClips([...selected.keys()])}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            Remove
          </Button>

          <div className="ml-auto flex items-center gap-2">
            <Input
              value={storyFolder}
              onChange={e => setStoryFolder(e.target.value)}
              placeholder="Drive folder for stories"
              className="h-8 w-52 text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveToStories()}
              disabled={savingStories}
              title="Light repurpose, then straight into the story folder — no generation"
            >
              {savingStories
                ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                : <BookImage className="w-4 h-4 mr-1.5" />}
              Save to stories
            </Button>
            <Button size="sm" onClick={() => setPanelOpen(true)}>
              <Wand2 className="w-4 h-4 mr-1.5" />
              Generate
            </Button>
          </div>
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
