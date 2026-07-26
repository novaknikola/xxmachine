'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldHint, FieldLabel } from '@/components/ui/field'
import { Loader2, Pause, Play, RefreshCw, Zap } from 'lucide-react'
import { useStudioSettings } from './studio-settings'

interface Profile {
  id: string
  platform: string
  username: string
  autopilot: boolean
  autopilot_min_score: number
  min_score: number
  character_id: string | null
  status: string
  last_scanned_at: string | null
}

export function AutopilotTab() {
  const studio = useStudioSettings()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [dailyCap, setDailyCap] = useState('25')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/runpod/profiles')
      const data = await res.json()
      setProfiles(data.profiles ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function patch(id: string, fields: Record<string, unknown>) {
    setSaving(id)
    try {
      const res = await fetch('/api/runpod/profiles', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Update failed')
      }
      await load()
      toast.success('Autopilot updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(null)
    }
  }

  const onCount = profiles.filter(p => p.autopilot).length
  const cap = parseFloat(dailyCap) || 0
  const overCap = studio.todaySpendUsd >= cap && cap > 0

  return (
    <div className="space-y-6 max-w-4xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            Autopilot ops
          </CardTitle>
          <CardDescription>
            Scan → classify → replicate for tracked Discovery profiles. Stop all pauses every profile and the local batch queue.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-end gap-4">
            <Field className="w-40">
              <FieldLabel>Daily $ cap (soft)</FieldLabel>
              <Input
                type="number"
                min="0"
                step="1"
                value={dailyCap}
                onChange={e => setDailyCap(e.target.value)}
              />
              <FieldHint>UI warning only — hard stop lands with billing ledger.</FieldHint>
            </Field>
            <div className="pb-1 space-y-1">
              <p className="text-sm text-muted-foreground">Today (est.)</p>
              <p className={`text-xl font-semibold tabular-nums ${overCap ? 'text-destructive' : ''}`}>
                {studio.formatUsd(studio.todaySpendUsd)}
                {cap > 0 && (
                  <span className="text-sm font-normal text-muted-foreground"> / {studio.formatUsd(cap)}</span>
                )}
              </p>
            </div>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={load}>
                <RefreshCw className="w-4 h-4" />
                Refresh
              </Button>
              <Button variant="destructive" onClick={() => studio.requestStopAll()}>
                <Pause className="w-4 h-4" />
                Stop all
              </Button>
            </div>
          </div>
          {overCap && (
            <p className="text-sm text-destructive">
              Soft daily cap reached. Pause autopilot or raise the cap before more runs.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {onCount} profile{onCount === 1 ? '' : 's'} with autopilot on
            {studio.stopRequested ? ' · stop flag active' : ''}
          </p>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : profiles.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No tracked profiles yet. Add them under Discovery → Social Media.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {profiles.map(p => (
            <Card key={p.id}>
              <CardContent className="pt-1">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-2 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-base">@{p.username}</span>
                      <Badge variant="outline">{p.platform}</Badge>
                      {p.autopilot ? (
                        <Badge className="bg-primary/15 text-primary border-primary/20">Autopilot on</Badge>
                      ) : (
                        <Badge variant="secondary">Paused</Badge>
                      )}
                      {!p.character_id && (
                        <Badge variant="outline" className="text-amber-500 border-amber-500/40">
                          No character
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Min score {p.min_score}
                      {p.last_scanned_at && ` · last scan ${new Date(p.last_scanned_at).toLocaleString()}`}
                    </p>
                    <Field className="max-w-[200px]">
                      <FieldLabel>Autopilot min score</FieldLabel>
                      <Input
                        type="number"
                        defaultValue={p.autopilot_min_score}
                        key={`${p.id}-${p.autopilot_min_score}`}
                        onBlur={e => {
                          const v = parseFloat(e.target.value)
                          if (!Number.isFinite(v) || v === p.autopilot_min_score) return
                          patch(p.id, { autopilot_min_score: v })
                        }}
                      />
                    </Field>
                  </div>
                  <Button
                    variant={p.autopilot ? 'outline' : 'default'}
                    disabled={saving === p.id || (!p.character_id && !p.autopilot)}
                    onClick={() => {
                      if (!p.autopilot) studio.clearStop()
                      patch(p.id, { autopilot: !p.autopilot })
                    }}
                  >
                    {saving === p.id
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : p.autopilot
                        ? <Pause className="w-4 h-4" />
                        : <Play className="w-4 h-4" />}
                    {p.autopilot ? 'Pause' : 'Enable'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
