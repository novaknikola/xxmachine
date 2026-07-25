'use client'

import { useEffect, useState } from 'react'
import type { Fan, ScheduledMessage } from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Send, Calendar as CalendarIcon, Loader2, X, Clock, AlertCircle, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  fan: Fan | null
  open: boolean
  onClose: () => void
}

function isoLocal(date: Date): string {
  const tzOff = date.getTimezoneOffset() * 60000
  return new Date(date.getTime() - tzOff).toISOString().slice(0, 16)
}

export function ScheduleMessageDialog({ fan, open, onClose }: Props) {
  const [text, setText] = useState('')
  const [price, setPrice] = useState<string>('')
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [scheduledAt, setScheduledAt] = useState<string>(() => {
    const next = new Date()
    next.setMinutes(next.getMinutes() + 30)
    return isoLocal(next)
  })
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<ScheduledMessage[]>([])

  useEffect(() => {
    if (!open || !fan) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText('')
    setPrice('')
    setMode('now')
    loadPending()
  }, [open, fan])

  if (!fan) return null
  async function loadPending() {
  if (!fan) return

  const res = await fetch(`/api/fanvue/schedule-message?fanId=${fan.id}`)
  if (!res.ok) return

  const data = await res.json()
  setPending(data)
}
  function refreshPending() {
    if (fan) loadPending()
  }

  async function sendNow() {
    if (!fan?.fanvueUserUuid) { toast.error('Fan is not Fanvue-synced'); return }
    if (!text.trim() && !price) { toast.error('Add a message or PPV price'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/fanvue/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userUuid: fan.fanvueUserUuid,
          text: text.trim() || undefined,
          price: price ? Number(price) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : data?.error || 'send failed')
      toast.success('Message sent')
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'send failed')
    } finally {
      setBusy(false)
    }
  }

  async function schedule() {
    if (!fan?.fanvueUserUuid) { toast.error('Fan is not Fanvue-synced'); return }
    if (!text.trim() && !price) { toast.error('Add a message or PPV price'); return }
    if (!scheduledAt) { toast.error('Pick a date/time'); return }
    const at = new Date(scheduledAt)
    if (Number.isNaN(at.getTime())) { toast.error('Invalid date'); return }
    if (at.getTime() <= Date.now() + 60_000) { toast.error('Pick at least 1 minute in the future'); return }

    setBusy(true)
    try {
      const res = await fetch('/api/fanvue/schedule-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fanId: fan.id,
          userUuid: fan.fanvueUserUuid,
          text: text.trim() || undefined,
          price: price ? Number(price) : undefined,
          scheduledAt: at.toISOString(),
          listName: `xx-${fan.fanvueHandle ?? 'fan'}-${Date.now()}`,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : data?.error || 'schedule failed')

     await loadPending()
      toast.success(`Scheduled for ${at.toLocaleString()}`)
      setText('')
      setPrice('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'schedule failed')
    } finally {
      setBusy(false)
    }
  }

  async function cancel(item: ScheduledMessage) {
    if (!confirm('Cancel this scheduled message?')) return
    try {
      await fetch('/api/fanvue/schedule-message', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: item.id,
          massMessageUuid: item.massMessageUuid,
          customListUuid: item.customListUuid,
        }),
      })
      await loadPending()
      toast.success('Cancelled')
    } catch {
      toast.error('Cancel failed')
    }
  }

  async function forget(item: ScheduledMessage) {
  await fetch('/api/fanvue/schedule-message', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id }),
  })

  await loadPending()
}

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[92vh] overflow-y-auto bg-card border-white/10">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Send className="w-4 h-4 text-primary" />
            Message {fan.displayName}
          </DialogTitle>
        </DialogHeader>

        {!fan.fanvueUserUuid && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            Fan is not Fanvue-synced (no UUID). Sync first.
          </div>
        )}

        <div className="flex gap-1">
          <button
            onClick={() => setMode('now')}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider transition-colors ${
              mode === 'now'
                ? 'bg-primary/15 text-primary border border-primary/30'
                : 'border border-white/8 text-muted-foreground hover:text-foreground'
            }`}
          >
            Send now
          </button>
          <button
            onClick={() => setMode('schedule')}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider transition-colors ${
              mode === 'schedule'
                ? 'bg-primary/15 text-primary border border-primary/30'
                : 'border border-white/8 text-muted-foreground hover:text-foreground'
            }`}
          >
            Schedule
          </button>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground">Message</Label>
            <Textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Type your message…"
              rows={4}
              className="bg-input border-white/10 text-sm resize-none rounded-xl"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground">PPV price (optional)</Label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">$</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={e => setPrice(e.target.value)}
                placeholder="0.00"
                className="bg-input border-white/10 h-9 rounded-xl text-sm w-32"
              />
              <span className="text-[11px] text-muted-foreground/70">leave empty for free message</span>
            </div>
          </div>

          {mode === 'schedule' && (
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground flex items-center gap-1">
                <CalendarIcon className="w-3 h-3" />
                Send at
              </Label>
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={e => setScheduledAt(e.target.value)}
                className="bg-input border-white/10 h-9 rounded-xl text-sm"
              />
              <p className="text-[10px] text-muted-foreground/70">
                Uses Fanvue&apos;s native scheduling via mass-of-one custom list. Cancel anytime before send.
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="rounded-xl border-white/10" onClick={onClose}>Cancel</Button>
            {mode === 'now' ? (
              <Button
                size="sm"
                className="rounded-xl bg-primary text-primary-foreground glow-primary"
                onClick={sendNow}
                disabled={busy || !fan.fanvueUserUuid}
              >
                {busy ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Sending…</>
                  : <><Send className="w-3 h-3 mr-1" /> Send</>}
              </Button>
            ) : (
              <Button
                size="sm"
                className="rounded-xl bg-primary text-primary-foreground glow-primary"
                onClick={schedule}
                disabled={busy || !fan.fanvueUserUuid}
              >
                {busy ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Scheduling…</>
                  : <><CalendarIcon className="w-3 h-3 mr-1" /> Schedule</>}
              </Button>
            )}
          </div>
        </div>

        {pending.length > 0 && (
          <>
            <Separator className="bg-white/5 my-2" />
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground font-semibold">
                Scheduled for this fan
              </p>
              {pending.map(item => (
                <div key={item.id} className="rounded-lg border border-white/8 bg-white/[0.02] p-2 text-xs space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-mono text-foreground">
                      <Clock className="w-3 h-3 text-primary" />
                      {new Date(item.scheduledAt).toLocaleString()}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={`text-[9px] h-5 px-1.5 font-mono uppercase ${
                          item.status === 'pending' ? 'border-primary/40 bg-primary/10 text-primary'
                          : item.status === 'cancelled' ? 'border-white/10 text-muted-foreground'
                          : item.status === 'failed' ? 'border-destructive/40 bg-destructive/10 text-destructive'
                          : 'border-tertiary/40 bg-tertiary/10 text-tertiary'
                        }`}
                      >
                        {item.status}
                      </Badge>
                      {item.status === 'pending' && (
                        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-destructive" onClick={() => cancel(item)}>
                          <X className="w-3 h-3" />
                        </Button>
                      )}
                      {item.status !== 'pending' && (
                        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-muted-foreground" onClick={() => forget(item)}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="text-foreground/80 line-clamp-2">{item.text || <span className="italic">(no text)</span>}</p>
                  {item.price && <p className="text-tertiary text-[10px] font-mono">PPV ${item.price.toFixed(2)}</p>}
                </div>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
