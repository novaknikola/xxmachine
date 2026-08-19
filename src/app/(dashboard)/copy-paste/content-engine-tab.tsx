'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Sparkles, Trash2, Copy, Pencil, Check, X, Lightbulb, History } from 'lucide-react'

interface SceneEvent {
  timestamp: string
  speaker: string
  line: string | null
  delivery: string | null
  action: string
}
interface Script {
  duration_seconds: number
  scene_events: SceneEvent[]
  [key: string]: unknown
}
interface ScriptItem {
  id: string
  topic: string
  script: Script
  created_at: string
  updated_at: string
}
export function ContentEngineTab() {
  const [topic, setTopic] = useState('')
  const [generating, setGenerating] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [items, setItems] = useState<ScriptItem[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [ideas, setIdeas] = useState<string[]>([])
  const [loadingIdeas, setLoadingIdeas] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const loadItems = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await fetch('/api/content-engine/scripts')
      const data = await res.json()
      setItems(data.items ?? [])
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    loadItems()
  }, [loadItems])

  async function handleGenerate() {
    if (!topic.trim() || generating) return
    setGenerating(true)
    setError(null)
    setWarnings([])
    try {
      const res = await fetch('/api/content-engine/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Generation failed')
      setWarnings((data.warnings ?? []).map((w: { message: string }) => w.message))
      setTopic('')
      await loadItems()
      setShowHistory(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  async function handleSuggestIdeas() {
    if (loadingIdeas) return
    setLoadingIdeas(true)
    setError(null)
    try {
      const res = await fetch('/api/content-engine/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed: topic.trim() || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Idea generation failed')
      setIdeas(data.ideas ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Idea generation failed')
    } finally {
      setLoadingIdeas(false)
    }
  }

  function pickIdea(idea: string) {
    setTopic(idea)
    setIdeas(prev => prev.filter(i => i !== idea))
  }

  async function handleDelete(id: string) {
    setItems(prev => prev.filter(i => i.id !== id))
    await fetch(`/api/content-engine/scripts/${id}`, { method: 'DELETE' })
  }

  function startEdit(item: ScriptItem) {
    setEditingId(item.id)
    setEditText(JSON.stringify(item.script, null, 2))
  }

  async function saveEdit(id: string) {
    let parsed: Script
    try {
      parsed = JSON.parse(editText)
    } catch {
      setError('Invalid JSON -- fix it before saving')
      return
    }
    const res = await fetch(`/api/content-engine/scripts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: parsed }),
    })
    if (res.ok) {
      setEditingId(null)
      await loadItems()
    } else {
      setError('Save failed')
    }
  }

  function copyJson(script: Script) {
    navigator.clipboard.writeText(JSON.stringify(script, null, 2)).catch(() => {})
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Generate a script</CardTitle>
          <CardDescription>
            Type a topic or idea. Grok drafts the dialogue in your style &mdash; review it
            below before rendering. No video is generated here yet, this only writes text.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input
              placeholder='e.g. "BMW drivers who never signal"'
              value={topic}
              onChange={e => setTopic(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleGenerate()}
              disabled={generating}
            />
            <Button onClick={handleGenerate} disabled={generating || !topic.trim()}>
              {generating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              Generate
            </Button>
            <Button
              variant="outline"
              onClick={handleSuggestIdeas}
              disabled={loadingIdeas}
              title={topic.trim() ? 'Riff on what you typed' : 'Leave blank for brand-new topics'}
            >
              {loadingIdeas ? <Loader2 className="size-4 animate-spin" /> : <Lightbulb className="size-4" />}
              Suggest ideas
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowHistory(v => !v)}
              title="Browse scripts already generated -- reuse one as-is, no regeneration"
            >
              <History className="size-4" />
              History{items.length > 0 ? ` (${items.length})` : ''}
            </Button>
          </div>
          {ideas.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {ideas.map((idea, i) => (
                <Badge
                  key={i}
                  variant="secondary"
                  className="cursor-pointer"
                  onClick={() => pickIdea(idea)}
                >
                  {idea}
                </Badge>
              ))}
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {warnings.length > 0 && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              <p className="font-medium">Review before using:</p>
              <ul className="list-disc pl-5">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {showHistory && (
        <div className="space-y-4">
          {loadingList && (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loadingList && items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No scripts yet &mdash; generate your first one above.
            </p>
          )}
          {items.map(item => (
            <Card key={item.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{item.topic}</CardTitle>
                    <CardDescription>
                      {new Date(item.created_at).toLocaleString()} &middot; {item.script.duration_seconds}s
                    </CardDescription>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => copyJson(item.script)} title="Copy JSON">
                      <Copy className="size-4" />
                    </Button>
                    {editingId === item.id ? (
                      <>
                        <Button variant="ghost" size="icon-sm" onClick={() => saveEdit(item.id)} title="Save">
                          <Check className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setEditingId(null)} title="Cancel">
                          <X className="size-4" />
                        </Button>
                      </>
                    ) : (
                      <Button variant="ghost" size="icon-sm" onClick={() => startEdit(item)} title="Edit JSON">
                        <Pencil className="size-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm" onClick={() => handleDelete(item.id)} title="Delete">
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {editingId === item.id ? (
                  <Textarea
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    className="min-h-64 font-mono text-xs"
                  />
                ) : (
                  <div className="space-y-2">
                    {item.script.scene_events?.map((e, i) => (
                      <div key={i} className="flex gap-3 text-sm">
                        <span className="w-24 shrink-0 text-muted-foreground">{e.timestamp}</span>
                        <div>
                          <Badge variant={e.speaker === 'female_subject' ? 'default' : 'secondary'}>
                            {e.speaker}
                          </Badge>
                          {e.line && <span className="ml-2">&quot;{e.line}&quot;</span>}
                          <p className="text-xs text-muted-foreground">{e.action}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
