'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from 'sonner'
import { Plus, Trash2, BookOpen, Copy, Star, X } from 'lucide-react'

interface PromptEntry {
  id: string
  character_id: string
  prompt: string
  label: string | null
  tags: string[]
  used_count: number
  created_at: string
}

interface PromptLibraryModalProps {
  open: boolean
  onClose: () => void
  characterId: string
  characterName: string
  onSelect: (prompt: string) => void
  currentPrompt?: string
}

export function PromptLibraryModal({ open, onClose, characterId, characterName, onSelect, currentPrompt }: PromptLibraryModalProps) {
  const [prompts, setPrompts] = useState<PromptEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newPrompt, setNewPrompt] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newTag, setNewTag] = useState('')
  const [newTags, setNewTags] = useState<string[]>([])
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    if (!characterId) return
    setLoading(true)
    try {
      const res = await fetch(`/api/prompt-library?characterId=${characterId}`)
      const data = await res.json()
      setPrompts(data.prompts ?? [])
    } catch { toast.error('Failed to load library') }
    finally { setLoading(false) }
  }, [characterId])

  useEffect(() => { if (open) { load(); setAdding(false); setSearch('') } }, [open, load])

  async function save() {
    if (!newPrompt.trim()) return
    try {
      const res = await fetch('/api/prompt-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId, prompt: newPrompt, label: newLabel, tags: newTags }),
      })
      const data = await res.json()
      setPrompts(prev => [data.prompt, ...prev])
      setNewPrompt(''); setNewLabel(''); setNewTags([])
      setAdding(false)
      toast.success('Prompt saved')
    } catch { toast.error('Failed to save') }
  }

  async function saveCurrentPrompt() {
    if (!currentPrompt?.trim()) { toast.error('No current prompt to save'); return }
    try {
      const res = await fetch('/api/prompt-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId, prompt: currentPrompt }),
      })
      const data = await res.json()
      setPrompts(prev => [data.prompt, ...prev])
      toast.success('Current prompt saved to library')
    } catch { toast.error('Failed to save') }
  }

  async function deletePrompt(id: string) {
    await fetch('/api/prompt-library', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    setPrompts(prev => prev.filter(p => p.id !== id))
  }

  async function use(entry: PromptEntry) {
    onSelect(entry.prompt)
    // Increment used_count
    await fetch('/api/prompt-library', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: entry.id }),
    }).catch(() => {})
    toast.success('Prompt applied')
    onClose()
  }

  const filtered = prompts.filter(p =>
    !search || p.prompt.toLowerCase().includes(search.toLowerCase()) ||
    p.label?.toLowerCase().includes(search.toLowerCase()) ||
    p.tags.some(t => t.toLowerCase().includes(search.toLowerCase()))
  )

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-xl h-[600px] flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 pt-5 pb-3 shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2 text-base">
              <BookOpen className="w-4 h-4 text-primary" />
              Prompt Library — {characterName}
            </DialogTitle>
            <div className="flex gap-2">
              {currentPrompt?.trim() && (
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={saveCurrentPrompt}>
                  <Star className="w-3 h-3" />Save current
                </Button>
              )}
              <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setAdding(v => !v)}>
                <Plus className="w-3 h-3" />{adding ? 'Cancel' : 'Add new'}
              </Button>
            </div>
          </div>
        </DialogHeader>

        {/* Add new */}
        {adding && (
          <div className="px-5 py-3 border-b border-border space-y-2 shrink-0">
            <Textarea placeholder="Prompt text..." value={newPrompt}
              onChange={e => setNewPrompt(e.target.value)} rows={3}
              className="text-xs resize-none" />
            <div className="flex gap-2">
              <Input placeholder="Label (optional)" value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                className="text-xs h-7 flex-1" />
              <div className="flex gap-1 items-center flex-1">
                <Input placeholder="Add tag" value={newTag}
                  onChange={e => setNewTag(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newTag.trim()) {
                      setNewTags(prev => [...prev, newTag.trim()])
                      setNewTag('')
                    }
                  }}
                  className="text-xs h-7" />
              </div>
            </div>
            {newTags.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {newTags.map(t => (
                  <Badge key={t} variant="secondary" className="text-xs gap-1 cursor-pointer"
                    onClick={() => setNewTags(prev => prev.filter(x => x !== t))}>
                    {t} <X className="w-2.5 h-2.5" />
                  </Badge>
                ))}
              </div>
            )}
            <Button size="sm" className="w-full h-7 text-xs" onClick={save} disabled={!newPrompt.trim()}>
              Save prompt
            </Button>
          </div>
        )}

        {/* Search */}
        <div className="px-5 py-2 border-b border-border shrink-0">
          <Input placeholder="Search prompts..." value={search}
            onChange={e => setSearch(e.target.value)}
            className="text-xs h-7" />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {loading && <p className="text-xs text-muted-foreground text-center py-8">Loading...</p>}
          {!loading && filtered.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-8">
              {prompts.length === 0 ? 'No prompts saved yet.' : 'No results.'}
            </p>
          )}
          {filtered.map(entry => (
            <div key={entry.id}
              className="group p-3 rounded-lg border border-border bg-card hover:border-primary/40 transition-colors cursor-pointer"
              onClick={() => use(entry)}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  {entry.label && (
                    <p className="text-xs font-semibold text-primary mb-1">{entry.label}</p>
                  )}
                  <p className="text-xs text-foreground line-clamp-3">{entry.prompt}</p>
                  {entry.tags.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {entry.tags.map(t => (
                        <Badge key={t} variant="outline" className="text-[9px] h-3.5 px-1">{t}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(entry.prompt); toast.success('Copied') }}
                    className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground">
                    <Copy className="w-3 h-3" />
                  </button>
                  <button onClick={e => { e.stopPropagation(); deletePrompt(entry.id) }}
                    className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-destructive">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
              {entry.used_count > 0 && (
                <p className="text-[9px] text-muted-foreground/50 mt-1">Used {entry.used_count}×</p>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
