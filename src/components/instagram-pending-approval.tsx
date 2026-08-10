'use client'

import { useEffect, useState } from 'react'
import { CalendarClock, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { prettyAccountName } from '@/lib/utils'

interface PendingItem {
  id: string
  drive_file_id: string | null
  filename: string
  scheduled_at: string | null
  account_id: string
  account_name: string
  ig_username: string | null
}

export function InstagramPendingApproval() {
  const [items, setItems] = useState<PendingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/instagram/pending-approval')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      setItems(Array.isArray(data) ? data : [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load pending items')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function act(ids: string[], action: 'approve' | 'reject') {
    setBusy(true)
    try {
      const res = await fetch('/api/instagram/pending-approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Action failed')
      toast.success(action === 'approve' ? `Approved ${ids.length}` : `Rejected ${ids.length}`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  if (!loading && items.length === 0) return null

  return (
    <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-yellow-400" />
          Pending Approval {items.length > 0 && `(${items.length})`}
        </p>
        {items.length > 0 && (
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => act(items.map(i => i.id), 'approve')}
          >
            {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
            Approve all
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map(item => (
            <div key={item.id} className="flex items-center gap-3 rounded-lg border border-border bg-background/40 p-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.filename}</p>
                <p className="text-xs text-muted-foreground">
                  @{prettyAccountName(item.ig_username || item.account_name)}
                  {item.scheduled_at && ` · ${new Date(item.scheduled_at).toLocaleString()}`}
                </p>
              </div>
              <Button size="icon-sm" variant="ghost" className="h-7 w-7" disabled={busy}
                title="Approve" onClick={() => act([item.id], 'approve')}>
                <CheckCircle2 className="w-4 h-4 text-green-400" />
              </Button>
              <Button size="icon-sm" variant="ghost" className="h-7 w-7" disabled={busy}
                title="Reject" onClick={() => act([item.id], 'reject')}>
                <XCircle className="w-4 h-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
