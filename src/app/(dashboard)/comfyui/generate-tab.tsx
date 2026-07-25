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
import { Loader2, ListTodo, AlertCircle } from 'lucide-react'

interface Template {
  id: string
  name: string
  image_node_id: string | null
}

const POD_URL_RE = /^https:\/\/[a-z0-9-]+-\d+\.proxy\.runpod\.net\/?$/i

export function GenerateTab() {
  const router = useRouter()
  const [templates, setTemplates] = useState<Template[]>([])
  const [podUrl, setPodUrl] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [inputFolderId, setInputFolderId] = useState('')
  const [outputFolderId, setOutputFolderId] = useState('')
  const [prompts, setPrompts] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchTemplates = useCallback(async () => {
    const res = await fetch('/api/comfyui-templates').catch(() => null)
    if (res?.ok) { const d = await res.json(); setTemplates(d.templates ?? []) }
  }, [])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  const selectedTemplate = templates.find(t => t.id === templateId)
  const needsImage = !!selectedTemplate?.image_node_id
  const podUrlValid = podUrl.trim().length === 0 || POD_URL_RE.test(podUrl.trim())
  const promptCount = prompts.split('\n').filter(l => l.trim()).length

  async function submit() {
    const cleanPodUrl = podUrl.trim()
    if (!POD_URL_RE.test(cleanPodUrl)) { toast.error('Pod URL must look like https://<pod-id>-8188.proxy.runpod.net'); return }
    if (!templateId) { toast.error('Pick a template'); return }
    if (!outputFolderId.trim()) { toast.error('Output Drive folder ID required'); return }
    if (needsImage && !inputFolderId.trim()) { toast.error('This template needs an input image — set the input Drive folder'); return }
    if (promptCount === 0) { toast.error('Add at least one prompt'); return }

    setSubmitting(true)
    try {
      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'comfyui_pod_bulk',
          input: {
            podUrl: cleanPodUrl,
            templateId,
            inputDriveFolderId: inputFolderId.trim() || undefined,
            outputDriveFolderId: outputFolderId.trim(),
            prompts: prompts.split('\n').map(l => l.trim()).filter(Boolean),
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Submit failed')

      toast.success(`${promptCount} prompt${promptCount > 1 ? 's' : ''} sent to queue`, {
        description: 'Runs against your pod in the background — results land in your output Drive folder',
        action: { label: 'Open Queue', onClick: () => router.push('/comfyui?tab=queue') },
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
      {templates.length === 0 && (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-sm text-amber-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          No saved templates yet — add one in the Templates tab first.
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Pod</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">ComfyUI pod URL</Label>
            <Input value={podUrl} onChange={e => setPodUrl(e.target.value)}
              placeholder="https://abc123-8188.proxy.runpod.net" className="h-8 text-sm font-mono" />
            {!podUrlValid && <p className="text-[10px] text-destructive">Must be a RunPod proxy URL (https://&lt;pod-id&gt;-&lt;port&gt;.proxy.runpod.net)</p>}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Template</Label>
            <Select value={templateId} onValueChange={v => { if (v) setTemplateId(v) }}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select template..." /></SelectTrigger>
              <SelectContent>
                {templates.map(t => (
                  <SelectItem key={t.id} value={t.id}>{t.name}{t.image_node_id ? ' (needs input image)' : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Google Drive</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {needsImage && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Input folder ID <span className="opacity-60">(images cycled across prompts)</span></Label>
              <Input value={inputFolderId} onChange={e => setInputFolderId(e.target.value)} placeholder="folder ID from the Drive URL" className="h-8 text-sm font-mono" />
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Output folder ID <span className="opacity-60">(results uploaded here)</span></Label>
            <Input value={outputFolderId} onChange={e => setOutputFolderId(e.target.value)} placeholder="folder ID from the Drive URL" className="h-8 text-sm font-mono" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Prompts (1 per line)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea value={prompts} onChange={e => setPrompts(e.target.value)} rows={10}
            placeholder={"sitting on a beach, golden hour\nworking in a café, laptop open\n..."} className="resize-none font-mono text-sm" />
          <p className="text-xs text-muted-foreground">{promptCount} prompt{promptCount !== 1 ? 's' : ''} · max 50 per submission</p>
        </CardContent>
      </Card>

      <Button className="w-full" onClick={submit} disabled={submitting}>
        {submitting
          ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</>
          : <><ListTodo className="w-4 h-4 mr-2" />Queue Bulk Generate ({promptCount})</>}
      </Button>
      <p className="text-[10px] text-muted-foreground text-center">
        Your pod must be running for this to work. Nothing is uploaded through our servers — output goes straight to your Drive folder.
      </p>
    </div>
  )
}
