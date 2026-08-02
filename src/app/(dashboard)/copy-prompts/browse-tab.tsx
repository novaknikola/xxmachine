'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Pagination } from '@/components/ui/pagination'
import { CheckSquare, Loader2, Search, Sparkles, Square, Wand2 } from 'lucide-react'
import { GenerationPanel } from './generation-panel'

export interface ScrapedPromptItem {
  id: string
  title: string | null
  prompt: string
  preview_image_url: string | null
  media_urls: string[]
  author: string | null
  source_url: string | null
  has_template_args: boolean
}

const PAGE_SIZE = 24
type Sort = 'newest' | 'oldest' | 'title' | 'author'

export function BrowseTab() {
  const [items, setItems] = useState<ScrapedPromptItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<Sort>('newest')
  const [q, setQ] = useState('')
  const [qDebounced, setQDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  // Map (not a Set) so a selection survives paginating away from the page it
  // was made on — the panel needs the full item, not just its id.
  const [selected, setSelected] = useState<Map<string, ScrapedPromptItem>>(new Map())
  const [panelOpen, setPanelOpen] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 350)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => { setPage(1) }, [sort, qDebounced])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort })
      if (qDebounced) params.set('q', qDebounced)
      const res = await fetch(`/api/scraped-prompts?${params.toString()}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load prompts')
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load prompts')
    } finally {
      setLoading(false)
    }
  }, [page, sort, qDebounced])

  useEffect(() => { load() }, [load])

  function toggleSelect(item: ScrapedPromptItem) {
    setSelected(prev => {
      const next = new Map(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.set(item.id, item)
      return next
    })
  }

  function toggleSelectAllOnPage() {
    setSelected(prev => {
      const next = new Map(prev)
      const allSelected = items.length > 0 && items.every(it => next.has(it.id))
      for (const it of items) {
        if (allSelected) next.delete(it.id)
        else next.set(it.id, it)
      }
      return next
    })
  }

  const allOnPageSelected = items.length > 0 && items.every(it => selected.has(it.id))
  const selectedItems = [...selected.values()]

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search title or prompt..."
            value={q}
            onChange={e => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={sort} onValueChange={v => setSort(v as Sort)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest</SelectItem>
            <SelectItem value="oldest">Oldest</SelectItem>
            <SelectItem value="title">Title</SelectItem>
            <SelectItem value="author">Author</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={toggleSelectAllOnPage} disabled={!items.length}>
          {allOnPageSelected ? <CheckSquare className="w-4 h-4 mr-1.5" /> : <Square className="w-4 h-4 mr-1.5" />}
          Select page
        </Button>
        <p className="text-xs text-muted-foreground ml-auto">{total.toLocaleString()} prompts</p>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <Sparkles className="w-12 h-12 opacity-10 mb-3" />
            <p className="text-sm">No prompts found</p>
          </div>
        ) : (
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {items.map(item => {
              const isSelected = selected.has(item.id)
              return (
                <Card
                  key={item.id}
                  size="sm"
                  className={`cursor-pointer overflow-hidden py-0 transition-colors ${isSelected ? 'ring-2 ring-primary' : 'hover:ring-1 hover:ring-border'}`}
                  onClick={() => toggleSelect(item)}
                >
                  <div className="relative aspect-square bg-secondary/40">
                    {item.preview_image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.preview_image_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
                        <Sparkles className="w-6 h-6" />
                      </div>
                    )}
                    <div
                      className={`absolute top-1.5 right-1.5 w-5 h-5 rounded-md border flex items-center justify-center ${isSelected ? 'bg-primary border-primary' : 'bg-black/40 border-white/40'}`}
                    >
                      {isSelected && <CheckSquare className="w-3.5 h-3.5 text-primary-foreground" />}
                    </div>
                    {item.has_template_args && (
                      <Badge variant="secondary" className="absolute bottom-1.5 left-1.5 text-[9px] h-4 px-1.5">
                        remix
                      </Badge>
                    )}
                  </div>
                  <CardContent className="p-2.5 space-y-1">
                    <p className="text-xs font-medium truncate">{item.title || 'Untitled'}</p>
                    <p className="text-[10px] text-muted-foreground line-clamp-2">{item.prompt}</p>
                    {item.author && <p className="text-[10px] text-muted-foreground/70 truncate">@{item.author}</p>}
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
