'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { Loader2, ListTodo, AlertCircle, CheckCircle2, XCircle } from 'lucide-react'

interface PodSession {
  id: string
  name: string
  connected: boolean
  healthy: boolean
  comfyBaseUrl: string | null
  lastError: string | null
  hasFishApiKey?: boolean
}

interface Defaults {
  talkSessionId: string | null
  animateSessionId: string | null
  i2vSessionId: string | null
}

type Workflow = 'infinitetalk' | 'animate'

export function GenerateTab() {
  const router = useRouter()
  const [workflow, setWorkflow] = useState<Workflow>('infinitetalk')
  const [sessions, setSessions] = useState<PodSession[]>([])
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [podSessionId, setPodSessionId] = useState('')
  const [inputFolderId, setInputFolderId] = useState('')
  const [outputFolderId, setOutputFolderId] = useState('')
  const [prompts, setPrompts] = useState('')
  const [fishVoiceId, setFishVoiceId] = useState('')
  const [style, setStyle] = useState('')
  const [spokenTexts, setSpokenTexts] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchMeta = useCallback(async () => {
    const sRes = await fetch('/api/my-pod/session').catch(() => null)
    if (sRes?.ok) {
      const d = await sRes.json()
      setSessions(Array.isArray(d.sessions) ? d.sessions : [])
      setDefaults(d.defaults ?? null)
    }
  }, [])

  useEffect(() => { fetchMeta() }, [fetchMeta])

  // Prefer workflow default when workflow or sessions change
  useEffect(() => {
    const preferred = workflow === 'infinitetalk'
      ? defaults?.talkSessionId
      : defaults?.animateSessionId
    if (preferred && sessions.some(s => s.id === preferred)) {
      setPodSessionId(preferred)
      return
    }
    const healthy = sessions.find(s => s.healthy)
    if (healthy) setPodSessionId(healthy.id)
    else if (sessions[0]) setPodSessionId(sessions[0].id)
    else setPodSessionId('')
  }, [workflow, sessions, defaults])

  const selected = sessions.find(s => s.id === podSessionId) ?? null
  const textLines = prompts.split('\n').map(l => l.trim()).filter(Boolean)
  const spokenLines = spokenTexts.split('\n').map(l => l.trim())

  async function submit() {
    if (!selected?.connected || !selected.healthy) {
      toast.error('Select a healthy pod — connect & Test in Connection')
      return
    }
    if (!outputFolderId.trim()) {
      toast.error('Output Drive folder ID required')
      return
    }
    if (!inputFolderId.trim()) {
      toast.error('Input Drive folder required')
      return
    }

    setSubmitting(true)
    try {
      let body: Record<string, unknown>

      if (workflow === 'infinitetalk') {
        if (!fishVoiceId.trim()) throw new Error('FishVoiceID required')
        if (textLines.length === 0) throw new Error('Add at least one Text line')
        body = {
          job_type: 'my_pod_talk',
          input: {
            inputDriveFolderId: inputFolderId.trim(),
            outputDriveFolderId: outputFolderId.trim(),
            fishVoiceId: fishVoiceId.trim(),
            style: style.trim() || undefined,
            texts: textLines,
            spokenTexts: spokenLines.some(Boolean) ? spokenLines : undefined,
            podSessionId,
          },
        }
      } else {
        body = {
          job_type: 'my_pod_animate',
          input: {
            inputDriveFolderId: inputFolderId.trim(),
            outputDriveFolderId: outputFolderId.trim(),
            podSessionId,
          },
        }
      }

      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Submit failed')

      const label = workflow === 'infinitetalk'
        ? `${textLines.length} InfiniteTalk clip(s)`
        : 'WAN Animate batch'
      toast.success(`${label} queued on ${selected.name}`, {
        description: 'Results land in Drive',
        action: { label: 'Open Queue', onClick: () => router.push('/my-pod?tab=queue') },
      })
      if (workflow === 'infinitetalk') {
        setPrompts('')
        setSpokenTexts('')
      }
      fetchMeta()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-xl mx-auto space-y-4">
      {sessions.length === 0 ? (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-sm text-amber-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          Connect a pod in the Connection tab first.
        </div>
      ) : selected?.healthy ? (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-400">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {selected.name} online · {selected.comfyBaseUrl}
        </div>
      ) : (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-destructive/30 bg-destructive/10 text-sm text-destructive">
          <XCircle className="w-4 h-4 shrink-0" />
          {selected ? `${selected.name} unhealthy — ${selected.lastError ?? 'Test connection'}` : 'Select a pod'}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Workflow</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select
            value={workflow}
            onValueChange={v => {
              if (v === 'infinitetalk' || v === 'animate') setWorkflow(v)
            }}
          >
            <SelectTrigger className="h-10 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="infinitetalk">InfiniteTalk — Fish + Comfy</SelectItem>
              <SelectItem value="animate">WAN Animate — image + driving video</SelectItem>
            </SelectContent>
          </Select>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Pod</Label>
            <Select
              value={podSessionId || undefined}
              onValueChange={v => { if (v) setPodSessionId(v) }}
            >
              <SelectTrigger className="h-10 text-xs"><SelectValue placeholder="Select pod" /></SelectTrigger>
              <SelectContent>
                {sessions.map(s => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}{s.healthy ? '' : ' (unhealthy)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {workflow === 'infinitetalk'
              ? 'Drive image → Fish TTS → InfiniteTalk → Drive video. Talk + Animate can run in parallel on different pods.'
              : 'One reference image + driving videos → WAN Animate → Drive video.'}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Google Drive</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Input folder ID{' '}
              <span className="opacity-60">
                {workflow === 'animate'
                  ? '(1 reference image + driving videos, flat)'
                  : '(portrait images, flat)'}
              </span>
            </Label>
            <Input
              value={inputFolderId}
              onChange={e => setInputFolderId(e.target.value)}
              placeholder="folder ID from the Drive URL"
              className="h-10 text-sm font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Output folder ID</Label>
            <Input
              value={outputFolderId}
              onChange={e => setOutputFolderId(e.target.value)}
              placeholder="folder ID from the Drive URL"
              className="h-10 text-sm font-mono"
            />
          </div>
        </CardContent>
      </Card>

      {workflow === 'infinitetalk' && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Fish Audio</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">FishVoiceID</Label>
                <Input
                  value={fishVoiceId}
                  onChange={e => setFishVoiceId(e.target.value)}
                  placeholder="voice reference_id from Fish"
                  className="h-10 text-sm font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  Style <span className="opacity-60 font-normal">(optional — e.g. [soft tone])</span>
                </Label>
                <Input
                  value={style}
                  onChange={e => setStyle(e.target.value)}
                  placeholder="[soft tone]"
                  className="h-10 text-sm"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                Text (1 per line)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={prompts}
                onChange={e => setPrompts(e.target.value)}
                rows={8}
                placeholder={'Hey… come closer.\nI missed you today.'}
                className="resize-none font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {textLines.length} line{textLines.length !== 1 ? 's' : ''} · paired with images (cycled if counts differ)
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                SpokenText <span className="opacity-60 font-normal">(optional, 1 per line)</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={spokenTexts}
                onChange={e => setSpokenTexts(e.target.value)}
                rows={4}
                placeholder="Leave blank to speak Text as-is. Use commas / ellipses for pacing…"
                className="resize-none font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Overrides Text for TTS only (caption stays as Text). Blank line = use Text.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      {workflow === 'animate' && (
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Put <span className="text-foreground">one</span> reference portrait (png/jpg) and one or more
              driving videos (mp4/webm) in the input folder. Each video becomes one Animate job using that
              same face. Frame count is probed from each video automatically.
            </p>
          </CardContent>
        </Card>
      )}

      <Button className="w-full h-10" onClick={submit} disabled={submitting || !selected?.healthy}>
        {submitting
          ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Queuing…</>
          : (
            <>
              <ListTodo className="w-4 h-4 mr-2" />
              {workflow === 'infinitetalk' ? 'Run InfiniteTalk on My Pod' : 'Run WAN Animate on My Pod'}
            </>
          )}
      </Button>
    </div>
  )
}
