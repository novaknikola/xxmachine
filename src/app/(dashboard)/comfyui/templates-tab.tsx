'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2, FileCode } from 'lucide-react'

interface Template {
  id: string
  name: string
  prompt_node_id: string
  prompt_field: string
  image_node_id: string | null
  image_field: string | null
  created_at: string
}

export function TemplatesTab() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [name, setName] = useState('')
  const [workflowJson, setWorkflowJson] = useState('')
  const [promptNodeId, setPromptNodeId] = useState('')
  const [promptField, setPromptField] = useState('text')
  const [imageNodeId, setImageNodeId] = useState('')
  const [imageField, setImageField] = useState('image')

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/comfyui-templates')
      if (res.ok) { const d = await res.json(); setTemplates(d.templates ?? []) }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  async function saveTemplate() {
    if (!name.trim()) { toast.error('Name required'); return }
    if (!workflowJson.trim()) { toast.error('Paste the workflow JSON (ComfyUI → Save (API Format))'); return }
    if (!promptNodeId.trim()) { toast.error('Prompt node ID required'); return }

    setSaving(true)
    try {
      const res = await fetch('/api/comfyui-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          workflowJson,
          promptNodeId: promptNodeId.trim(),
          promptField: promptField.trim() || 'text',
          imageNodeId: imageNodeId.trim() || undefined,
          imageField: imageField.trim() || 'image',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')

      toast.success('Template saved')
      setName(''); setWorkflowJson(''); setPromptNodeId(''); setPromptField('text'); setImageNodeId(''); setImageField('image')
      fetchTemplates()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  async function deleteTemplate(id: string) {
    if (!confirm('Delete this template?')) return
    const res = await fetch('/api/comfyui-templates', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (res.ok) { toast.success('Deleted'); fetchTemplates() }
    else toast.error('Delete failed')
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6 max-w-5xl mx-auto">
      {/* Saved templates */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Saved templates</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <FileCode className="w-8 h-8 mx-auto mb-2 opacity-20" />
              <p className="text-sm">No templates yet — add one from an exported ComfyUI workflow</p>
            </div>
          ) : (
            <div className="space-y-2">
              {templates.map(t => (
                <div key={t.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{t.name}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      prompt node <span className="font-mono text-primary">{t.prompt_node_id}</span>.<span className="font-mono">{t.prompt_field}</span>
                      {t.image_node_id && <> · image node <span className="font-mono text-primary">{t.image_node_id}</span>.<span className="font-mono">{t.image_field}</span></>}
                    </p>
                  </div>
                  <button onClick={() => deleteTemplate(t.id)}
                    className="w-7 h-7 rounded-md border border-border flex items-center justify-center hover:border-destructive hover:text-destructive transition-colors shrink-0">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add template */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Add template</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. WAN I2V pod" className="h-8 text-sm" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Workflow JSON <span className="opacity-60">(ComfyUI → Save (API Format))</span></Label>
            <Textarea value={workflowJson} onChange={e => setWorkflowJson(e.target.value)} rows={6}
              placeholder='{"3": {"class_type": "KSampler", ...}, ...}' className="font-mono text-xs resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Prompt node ID</Label>
              <Input value={promptNodeId} onChange={e => setPromptNodeId(e.target.value)} placeholder="6" className="h-8 text-sm font-mono" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Prompt field</Label>
              <Input value={promptField} onChange={e => setPromptField(e.target.value)} placeholder="text" className="h-8 text-sm font-mono" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Image node ID <span className="opacity-60">(optional)</span></Label>
              <Input value={imageNodeId} onChange={e => setImageNodeId(e.target.value)} placeholder="10" className="h-8 text-sm font-mono" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Image field</Label>
              <Input value={imageField} onChange={e => setImageField(e.target.value)} placeholder="image" className="h-8 text-sm font-mono" />
            </div>
          </div>
          <Button className="w-full" onClick={saveTemplate} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
            Save template
          </Button>
          <p className="text-[10px] text-muted-foreground">
            Leave image fields blank if this workflow only needs a text prompt (no reference image).
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
