'use client'

import { useState } from 'react'
import { paydayRuleFromSummary } from '@/lib/fans'
import type { Fan, AiSummary } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sparkles,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Wallet,
  AlertCircle,
  Copy,
} from 'lucide-react'
import { toast } from 'sonner'

interface ChatMessageLite {
  fromCreator: boolean
  text: string
  sentAt: string | null
  hasMedia: boolean
  type: string | null
  ppvCents?: number
  purchased?: boolean
}

interface Props {
  fan: Fan
  onUpdated: () => void
}

export function FanAiBubble({ fan, onUpdated }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(fan.aiSummaryError ?? null)

  const summary = fan.aiSummary

  async function generate() {
    if (!fan.fanvueUserUuid) {
      toast.error('This fan is not synced from Fanvue (no UUID).')
      return
    }
    setLoading(true)
    setError(null)
    try {
      // 1) pull chat messages
      const msgRes = await fetch('/api/fanvue/chat-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userUuid: fan.fanvueUserUuid, limit: 50 }),
      })
      const msgJson = await msgRes.json()
      if (!msgRes.ok) {
        const msg = msgJson?.detail || msgJson?.error || 'chat fetch failed'
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
      }
      const messages: ChatMessageLite[] = msgJson.messages ?? []

      // 2) send to Gemini
      const sumRes = await fetch('/api/ai/fan-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fan: {
            displayName: fan.displayName,
            handle: fan.fanvueHandle,
            status: fan.status,
            lifetimeGrossCents: fan.lifetimeGrossCents,
            lastPurchaseAt: fan.lastPurchaseAt,
            subscriptionCreatedAt: fan.subscriptionCreatedAt,
            spendingSources: fan.spendingSources,
          },
          messages,
        }),
      })
      const sumJson = await sumRes.json()
      if (!sumRes.ok) throw new Error(sumJson?.error || 'AI summary failed')

      const aiSummary = sumJson.summary as AiSummary
      const aiSummaryAt = new Date().toISOString()

      const patch: Partial<Fan> = { aiSummary, aiSummaryAt, aiSummaryError: undefined }

      // Auto-set payday if Gemini found a pattern AND no manual rule yet
      if (aiSummary.paydayPattern && fan.payday.kind === 'none') {
        const rule = paydayRuleFromSummary(aiSummary.paydayPattern)
        if (rule) patch.payday = rule
      }

      await fetch(`/api/fans/${fan.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
})
      onUpdated()
      toast.success(`AI summary generated (${messages.length} msgs)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      setError(msg)
      await fetch(`/api/fans/${fan.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ aiSummaryError: msg }),
})
      onUpdated()
      toast.error(`AI summary failed: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  function copyHook(text: string) {
    navigator.clipboard.writeText(text)
    toast.success('Copied to clipboard')
  }

  const hasData = !!summary && (summary.preferences.length || summary.dailyHooks.length || summary.keyFacts.length)

  return (
    <div className="rounded-xl border border-cyan-accent/20 bg-cyan-accent/[0.04]">
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-3.5 h-3.5 text-cyan-accent shrink-0" />
          <span className="text-[11px] font-mono uppercase tracking-wider text-cyan-accent font-semibold">
            AI Summary
          </span>
          {hasData && summary?.mood && (
            <span className="text-[10px] text-foreground/80 truncate">· {summary.mood}</span>
          )}
          {!hasData && !error && (
            <span className="text-[10px] text-muted-foreground/70 truncate">· not generated yet</span>
          )}
          {error && (
            <span className="text-[10px] text-destructive/80 truncate flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              error
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3" onClick={e => e.stopPropagation()}>
          {/* Generate / refresh button */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground font-mono">
              {fan.aiSummaryAt
                ? `Updated ${new Date(fan.aiSummaryAt).toLocaleString()}`
                : 'No data yet'}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] rounded-lg border-cyan-accent/30 bg-cyan-accent/10 text-cyan-accent hover:bg-cyan-accent/15"
              onClick={generate}
              disabled={loading || !fan.fanvueUserUuid}
            >
              {loading ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Working…</>
                : summary ? <><RefreshCw className="w-3 h-3 mr-1" /> Refresh</>
                : <><Sparkles className="w-3 h-3 mr-1" /> Generate</>}
            </Button>
          </div>

          {error && (
            <p className="text-[11px] text-destructive/90">{error}</p>
          )}

          {hasData && summary && (
            <>
              {/* Status pills row */}
              <div className="flex flex-wrap gap-1.5">
                {summary.paydayPattern && (
                  <Badge variant="outline" className="text-[10px] h-5 px-2 font-mono uppercase tracking-wider border-tertiary/40 bg-tertiary/10 text-tertiary">
                    <Wallet className="w-2.5 h-2.5 mr-1" />
                    {summary.paydayPattern}
                  </Badge>
                )}
                {summary.conversationTone && (
                  <Badge variant="outline" className="text-[10px] h-5 px-2 font-mono uppercase tracking-wider border-primary/40 bg-primary/10 text-primary">
                    {summary.conversationTone}
                  </Badge>
                )}
                {summary.lastOfferResponse && (
                  <Badge variant="outline" className="text-[10px] h-5 px-2 font-mono uppercase tracking-wider border-cyan-accent/40 bg-cyan-accent/10 text-cyan-accent">
                    {summary.lastOfferResponse}
                  </Badge>
                )}
              </div>

              {summary.preferences.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono mb-1">Likes</p>
                  <div className="flex flex-wrap gap-1">
                    {summary.preferences.map((p, i) => (
                      <Badge key={i} variant="outline" className="text-[10px] h-5 px-1.5 border-white/10 bg-white/5 text-foreground/80 font-mono">{p}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {summary.keyFacts.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono mb-1">Key facts</p>
                  <ul className="text-[11px] text-foreground/85 space-y-0.5 list-disc list-inside">
                    {summary.keyFacts.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              )}

              {summary.dailyHooks.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono mb-1">Today&apos;s hooks</p>
                  <div className="space-y-1">
                    {summary.dailyHooks.map((h, i) => (
                      <button
                        key={i}
                        onClick={() => copyHook(h)}
                        className="w-full text-left rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5 text-[11px] text-foreground/90 hover:border-primary/40 hover:bg-primary/5 transition-colors group flex items-start gap-2"
                      >
                        <span className="flex-1">{h}</span>
                        <Copy className="w-3 h-3 text-muted-foreground/60 opacity-0 group-hover:opacity-100 shrink-0 mt-0.5" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {summary.weeklyStrategy && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono mb-1">This week</p>
                  <p className="text-[11px] text-foreground/85 leading-snug italic">{summary.weeklyStrategy}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
