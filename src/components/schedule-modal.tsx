'use client'

import { useState, useEffect } from 'react'
import { Character } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { CalendarDays, Loader2, Send } from 'lucide-react'

function toLocalDatetimeInput(offsetMinutes = 60) {
  const d = new Date(Date.now() + offsetMinutes * 60_000)
  return d.toISOString().slice(0, 16)
}

interface ScheduleModalProps {
  open: boolean
  onClose: () => void
  imageUrls: string[]
  characterId?: string
  characterName?: string
}

export function ScheduleModal({ open, onClose, imageUrls, characterId: initCharId, characterName: initCharName }: ScheduleModalProps) {
  const [characters, setCharacters] = useState<Character[]>([])
  const [charId, setCharId] = useState(initCharId ?? '')
  const [caption, setCaption] = useState('')
  const [scheduledAt, setScheduledAt] = useState(toLocalDatetimeInput())
  const [loading, setLoading] = useState(false)

useEffect(() => {
  let cancelled = false

  async function loadCharacters() {
    try {
      const res = await fetch('/api/characters')
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to load characters')
      }

      if (!cancelled) {
        setCharacters(data)
      }
    } catch (err) {
      console.error('[schedule-modal] load characters failed', err)
      if (!cancelled) {
        setCharacters([])
      }
    }
  }

  loadCharacters()

  return () => {
    cancelled = true
  }
}, [])

  useEffect(() => {
    if (open) {
      setCharId(initCharId ?? '')
      setCaption('')
      setScheduledAt(toLocalDatetimeInput())
    }
  }, [open, initCharId])

  async function submit() {
    if (!imageUrls.length) { toast.error('No images to schedule'); return }
    if (!charId) { toast.error('Select a character'); return }
    const char = characters.find(c => c.id === charId)
    setLoading(true)
    try {
      const res = await fetch('/api/schedule/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
  characterId: charId,
  characterName: char?.name ?? initCharName ?? charId,
  imageUrls,
  caption: caption.trim() || 'Scheduled post',
  platforms: ['telegram'],
  scheduledAt: new Date(scheduledAt).toISOString(),
  createdBy: 'admin',
}),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      toast.success('Post scheduled — approval request sent to Telegram')
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to schedule')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="w-4 h-4 text-primary" />
            Schedule post
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Image preview */}
          <div className="flex gap-2 flex-wrap">
            {imageUrls.slice(0, 6).map((url, i) => (
              <div key={i} className="w-14 h-14 rounded-lg overflow-hidden border border-border shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="w-full h-full object-cover" />
              </div>
            ))}
            {imageUrls.length > 6 && (
              <div className="w-14 h-14 rounded-lg border border-border flex items-center justify-center text-xs text-muted-foreground">
                +{imageUrls.length - 6}
              </div>
            )}
          </div>

          {/* Character */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Character</Label>
            <Select value={charId} onValueChange={v => { if (v) setCharId(v) }}>
              <SelectTrigger><SelectValue placeholder="Select character..." /></SelectTrigger>
              <SelectContent>
                {characters.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Caption */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Caption <span className="opacity-50">(optional)</span></Label>
            <Textarea
              placeholder="Caption for this post..."
              value={caption}
              onChange={e => setCaption(e.target.value)}
              rows={3}
              className="resize-none text-sm"
            />
          </div>

          {/* Date/time */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Schedule time</Label>
            <Input
              type="datetime-local"
              value={scheduledAt}
              onChange={e => setScheduledAt(e.target.value)}
              className="text-sm"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={submit} disabled={loading || !charId}>
              {loading
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Scheduling...</>
                : <><Send className="w-4 h-4 mr-2" />Schedule</>}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
