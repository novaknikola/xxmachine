'use client'

import { useEffect, useRef, useState } from 'react'
import type { Fan } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Pencil, Plus, X, Tag, StickyNote, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  fan: Fan
  onUpdated: () => void
  onDeleted: () => void
}

export function FanNotesPopover({ fan, onUpdated, onDeleted }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(fan.displayName)
  const [notes, setNotes] = useState(fan.notes)
  const [tags, setTags] = useState<string[]>(fan.tags)
  const [tagInput, setTagInput] = useState('')
  const popRef = useRef<HTMLDivElement | null>(null)

  // Reset local state when fan prop changes (e.g. after sync)
  useEffect(() => {
    if (open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(fan.displayName)
    setNotes(fan.notes)
    setTags(fan.tags)
  }, [fan.displayName, fan.notes, fan.tags, open])

  // Click-outside to close (without saving)
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  function addTag() {
    const t = tagInput.trim()
    if (!t || tags.includes(t)) { setTagInput(''); return }
    setTags([...tags, t])
    setTagInput('')
  }

  async function save() {
    if (!name.trim()) {
      toast.error('Display name required')
      return
    }
    await fetch(`/api/fans/${fan.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ displayName: name.trim(), notes, tags }),
})
    onUpdated()
    setOpen(false)
    toast.success('Saved')
  }

  async function del() {
    if (!confirm(`Delete fan "${fan.displayName}"? This removes them from XXmachine only — Fanvue is untouched.`)) return
    await fetch(`/api/fans/${fan.id}`, {
  method: 'DELETE',
})
    onDeleted()
    setOpen(false)
    toast.success('Fan removed from XXmachine')
  }

  return (
    <div className="relative" ref={popRef}>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10"
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
      >
        <Pencil className="w-3 h-3 mr-1" />
        Edit
      </Button>

      {open && (
        <div
          className="absolute right-0 top-9 z-30 w-80 rounded-2xl border border-primary/25 bg-popover/95 backdrop-blur-xl shadow-2xl shadow-black/50 p-3 space-y-3"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-mono uppercase tracking-wider text-foreground font-semibold flex items-center gap-1.5">
              <Pencil className="w-3 h-3 text-primary" />
              Edit fan
            </p>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground">Display name</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              className="bg-input border-white/10 h-8 rounded-lg text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground flex items-center gap-1">
              <Tag className="w-3 h-3" />
              Tags
            </Label>
            <div className="flex flex-wrap gap-1 items-center">
              {tags.map(t => (
                <Badge key={t} variant="outline" className="text-[10px] h-5 px-1.5 border-primary/30 bg-primary/10 text-primary group">
                  {t}
                  <button
                    onClick={() => setTags(tags.filter(x => x !== t))}
                    className="ml-1 text-primary/60 hover:text-primary"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </Badge>
              ))}
              <div className="flex items-center gap-1">
                <Input
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
                  placeholder="add tag…"
                  className="bg-input border-white/10 h-7 w-24 rounded-lg text-[11px]"
                />
                <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={addTag}>
                  <Plus className="w-3 h-3" />
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground flex items-center gap-1">
              <StickyNote className="w-3 h-3" />
              Notes
            </Label>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={5}
              placeholder="What he likes, what he ignores, important things to remember…"
              className="bg-input border-white/10 text-sm resize-none rounded-lg"
            />
          </div>

          <div className="flex items-center justify-between pt-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive/80 hover:text-destructive hover:bg-destructive/10"
              onClick={del}
            >
              <Trash2 className="w-3 h-3 mr-1" />
              Delete
            </Button>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] rounded-lg" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" className="h-7 px-3 text-[11px] rounded-lg bg-primary text-primary-foreground" onClick={save}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
