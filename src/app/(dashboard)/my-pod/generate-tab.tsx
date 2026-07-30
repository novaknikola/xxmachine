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

interface Template {
  id: string
  name: string
  image_node_id: string | null
}

interface PodSession {
  connected: boolean
  healthy: boolean
  comfyBaseUrl: string | null
  lastError: string | null
}

type Mode = 'simple' | 'i2v' | 'animate'

export function GenerateTab() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('simple')
  const [session, setSession] = useState<PodSession | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [templateId, setTemplateId] = useState('')
  const [inputFolderId, setInputFolderId] = useState('')
  const [outputFolderId, setOutputFolderId] = useState('')
  const [prompts, setPrompts] = useState('')
  const [defaultPrompt, setDefaultPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchMeta = useCallback(async () => {
    const [sRes, tRes] = await Promise.all([
      fetch('/api/my-pod/session').catch(() => null),
      fetch('/api/comfyui-templates').catch(() => null),
    ])
    if (sRes?.ok) {
      const d = await sRes.json()
      setSession(d.session)
    }
    if (tRes?.ok) {
      const d = await tRes.json()
      setTemplates(d.templates ?? [])
    }
  }, [])

  useEffect(() => { fetchMeta() }, [fetchMeta])

  const selectedTemplate = templates.find(t => t.id === templateId)
  const needsImage = !!selectedTemplate?.image_node_id
  const promptCount = prompts.split('\n').filter(l => l.trim()).length

  async function submit() {
    if (!session?.connected || !session.healthy) {
      toast.error('Pod offline — connect & Test in Connection tab')
      return
    }
    if (!outputFolderId.trim()) {
      toast.error('Output Drive folder ID required')
      return
    }

    setSubmitting(true)
    try {
      let body: Record<string, unknown>

      if (mode === 'simple') {
        if (!templateId) throw new Error('Pick a template')
        if (needsImage && !inputFolderId.trim()) throw new Error('This template needs an input Drive folder')
        if (promptCount === 0) throw new Error('Add at least one prompt')
        body = {
          job_type: 'comfyui_pod_bulk',
          input: {
            usePodSession: true,
            templateId,
            inputDriveFolderId: inputFolderId.trim() || undefined,
            outputDriveFolderId: outputFolderId.trim(),
            prompts: prompts.split('\n').map(l => l.trim()).filter(Boolean),
          },
        }
      } else if (mode === 'i2v') {
        if (!inputFolderId.trim()) throw new Error('Input Drive folder with images required')
        body = {
          job_type: 'my_pod_i2v',
          input: {
            inputDriveFolderId: inputFolderId.trim(),
            outputDriveFolderId: outputFolderId.trim(),
            prompt: defaultPrompt.trim() || undefined,
          },
        }
      } else {
        if (!inputFolderId.trim()) throw new Error('Input Drive folder (reference image + driving videos) required')
        body = {
          job_type: 'my_pod_animate',
          input: {
            inputDriveFolderId: inputFolderId.trim(),
            outputDriveFolderId: outputFolderId.trim(),
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

      const label = mode === 'simple' ? `${promptCount} prompt(s)` : mode === 'i2v' ? 'I2V batch' : 'Animate batch'
      toast.success(`${label} queued`, {
        description: 'Runs on your pod — results land in Drive',
        action: { label: 'Open Queue', onClick: () => router.push('/my-pod?tab=queue') },
      })
      setPrompts('')
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
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Mode</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={mode} onValueChange={v => setMode(v as Mode)}>
            <SelectTrigger className="h-10 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="simple">Simple — API templates</SelectItem>
              <SelectItem value="i2v">WAN 2.2 I2V</SelectItem>
              <SelectItem value="animate">WAN 2.2 Animate</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {mode === 'simple' && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Template</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {templates.length === 0 && (
              <p className="text-xs text-amber-400">No templates — add one in Templates tab.</p>
            )}
            <Select value={templateId} onValueChange={v => { if (v) setTemplateId(v) }}>
              <SelectTrigger className="h-10 text-xs"><SelectValue placeholder="Select template..." /></SelectTrigger>
              <SelectContent>
                {templates.map(t => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}{t.image_node_id ? ' (needs image)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Google Drive</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(mode !== 'simple' || needsImage) && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Input folder ID{' '}
                <span className="opacity-60">
                  {mode === 'animate'
                    ? '(1 reference image + driving videos, flat)'
                    : mode === 'i2v'
                      ? '(images, flat)'
                      : '(images cycled across prompts)'}
                </span>
              </Label>
              <Input
                value={inputFolderId}
                onChange={e => setInputFolderId(e.target.value)}
                placeholder="folder ID from the Drive URL"
                className="h-10 text-sm font-mono"
              />
            </div>
          )}
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

      {mode === 'simple' && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Prompts (1 per line)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={prompts}
              onChange={e => setPrompts(e.target.value)}
              rows={10}
              placeholder={'sitting on a beach, golden hour\nworking in a café…'}
              className="resize-none font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">{promptCount} prompt{promptCount !== 1 ? 's' : ''} · max 50</p>
          </CardContent>
        </Card>
      )}

      {mode === 'i2v' && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
              Prompt <span className="opacity-60 font-normal">(optional override)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              value={defaultPrompt}
              onChange={e => setDefaultPrompt(e.target.value)}
              rows={3}
              placeholder="Leave blank for default subtle motion prompt"
              className="resize-none text-sm"
            />
          </CardContent>
        </Card>
      )}

      <Button className="w-full h-10" onClick={submit} disabled={submitting || !session?.healthy}>
        {submitting
          ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Queuing…</>
          : <><ListTodo className="w-4 h-4 mr-2" />Run on My Pod</>}
      </Button>
    </div>
  )
}
