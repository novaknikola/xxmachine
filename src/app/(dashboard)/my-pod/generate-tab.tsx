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
  connected: boolean
  healthy: boolean
  comfyBaseUrl: string | null
  lastError: string | null
}

export function GenerateTab() {
  const router = useRouter()
  const [workflow, setWorkflow] = useState('infinitetalk')
  const [session, setSession] = useState<PodSession | null>(null)
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
      setSession(d.session)
    }
  }, [])

  useEffect(() => { fetchMeta() }, [fetchMeta])

  const textLines = prompts.split('\n').map(l => l.trim()).filter(Boolean)
  const spokenLines = spokenTexts.split('\n').map(l => l.trim())

  async function submit() {
    if (!session?.connected || !session.healthy) {
      toast.error('Pod offline — connect & Test in Connection tab')
      return
    }
    if (workflow !== 'infinitetalk') {
      toast.error('This workflow is not available here yet')
      return
    }
    if (!outputFolderId.trim()) {
      toast.error('Output Drive folder ID required')
      return
    }
    if (!inputFolderId.trim()) {
      toast.error('Input Drive folder with images required')
      return
    }
    if (!fishVoiceId.trim()) {
      toast.error('FishVoiceID required')
      return
    }
    if (textLines.length === 0) {
      toast.error('Add at least one Text line')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'my_pod_talk',
          input: {
            inputDriveFolderId: inputFolderId.trim(),
            outputDriveFolderId: outputFolderId.trim(),
            fishVoiceId: fishVoiceId.trim(),
            style: style.trim() || undefined,
            texts: textLines,
            spokenTexts: spokenLines.some(Boolean) ? spokenLines : undefined,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Submit failed')

      toast.success(`${textLines.length} InfiniteTalk clip(s) queued`, {
        description: 'Runs on your pod — results land in Drive',
        action: { label: 'Open Queue', onClick: () => router.push('/my-pod?tab=queue') },
      })
      setPrompts('')
      setSpokenTexts('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-xl mx-auto space-y-4">
      {!session?.connected ? (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-sm text-amber-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          Connect a pod in the Connection tab first.
        </div>
      ) : session.healthy ? (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-400">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          Pod online · {session.comfyBaseUrl}
        </div>
      ) : (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-destructive/30 bg-destructive/10 text-sm text-destructive">
          <XCircle className="w-4 h-4 shrink-0" />
          Pod unhealthy — {session.lastError ?? 'Test connection'}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Workflow</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={workflow} onValueChange={v => { if (v) setWorkflow(v) }}>
            <SelectTrigger className="h-10 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="infinitetalk">InfiniteTalk — Fish + Comfy</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-2">
            Drive image → Fish TTS → InfiniteTalk → Drive video. Other workflows will get their own pages later.
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
              Input folder ID <span className="opacity-60">(portrait images, flat)</span>
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

      <Button className="w-full h-10" onClick={submit} disabled={submitting || !session?.healthy}>
        {submitting
          ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Queuing…</>
          : <><ListTodo className="w-4 h-4 mr-2" />Run InfiniteTalk on My Pod</>}
      </Button>
    </div>
  )
}
