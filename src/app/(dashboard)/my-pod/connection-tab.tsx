'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import {
  Loader2, Plug, PlugZap, RefreshCw, Unplug, CheckCircle2, XCircle, Plus, Pencil,
} from 'lucide-react'

interface PodSession {
  id: string
  name: string
  connected: boolean
  healthy: boolean
  comfyBaseUrl: string | null
  sshHostMasked: string | null
  sshPort: number | null
  sshUser: string | null
  hasFishApiKey: boolean
  lastOkAt: string | null
  lastError: string | null
}

export function ConnectionTab() {
  const [sessions, setSessions] = useState<PodSession[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  const [name, setName] = useState('')
  const [comfyBaseUrl, setComfyBaseUrl] = useState('')
  const [sshCommand, setSshCommand] = useState('')
  const [fishApiKey, setFishApiKey] = useState('')

  const editing = editingId
    ? sessions.find(s => s.id === editingId) ?? null
    : null

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/my-pod/session')
      if (res.ok) {
        const d = await res.json()
        setSessions(Array.isArray(d.sessions) ? d.sessions : [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSessions() }, [fetchSessions])

  function startAdd() {
    setEditingId(null)
    setName('')
    setComfyBaseUrl('')
    setSshCommand('')
    setFishApiKey('')
    setShowForm(true)
  }

  function startEdit(s: PodSession) {
    setEditingId(s.id)
    setName(s.name)
    setComfyBaseUrl(s.comfyBaseUrl ?? '')
    setSshCommand('')
    setFishApiKey('')
    setShowForm(true)
  }

  async function connect() {
    if (!comfyBaseUrl.trim() || !sshCommand.trim()) {
      toast.error('Paste ComfyUI URL and SSH command')
      return
    }
    if (!fishApiKey.trim() && !editing?.hasFishApiKey) {
      toast.error('Paste your Fish Audio API key (needed for Talk on this pod)')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/my-pod/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId ?? undefined,
          name: name.trim() || undefined,
          comfyBaseUrl: comfyBaseUrl.trim(),
          sshCommand: sshCommand.trim(),
          fishApiKey: fishApiKey.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Connect failed')
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
      setFishApiKey('')
      setSshCommand('')
      setShowForm(false)
      setEditingId(null)
      toast.success(editingId ? 'Pod updated' : 'Pod connected')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  async function test(sessionId: string) {
    setTestingId(sessionId)
    try {
      const res = await fetch('/api/my-pod/session/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Test failed')
      if (Array.isArray(data.sessions)) setSessions(data.sessions)
      toast.success('Connection healthy')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed')
      fetchSessions()
    } finally {
      setTestingId(null)
    }
  }

  async function disconnect(sessionId: string) {
    const res = await fetch(`/api/my-pod/session?id=${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
      if (editingId === sessionId) {
        setShowForm(false)
        setEditingId(null)
      }
      toast.success('Pod removed')
    } else {
      toast.error(data.error ?? 'Could not disconnect')
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest flex items-center justify-between">
            Pods ({sessions.length})
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={fetchSessions}>
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={startAdd}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Add
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {sessions.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Add one or more RunPods. Assign them per workflow in Workflows.
            </p>
          ) : (
            sessions.map(s => (
              <div key={s.id} className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">{s.name}</span>
                  <div className="flex items-center gap-1.5">
                    {s.healthy
                      ? <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /><span className="text-xs text-emerald-400">Online</span></>
                      : <><XCircle className="w-3.5 h-3.5 text-destructive" /><span className="text-xs text-destructive">Unhealthy</span></>}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground font-mono break-all">{s.comfyBaseUrl}</p>
                <p className="text-xs text-muted-foreground">
                  SSH {s.sshUser}@{s.sshHostMasked}:{s.sshPort}
                  {' · '}Fish: {s.hasFishApiKey ? 'saved' : 'missing'}
                </p>
                {s.lastError && (
                  <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2 font-mono break-all">{s.lastError}</p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => test(s.id)} disabled={testingId === s.id}>
                    {testingId === s.id
                      ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      : <PlugZap className="w-3.5 h-3.5 mr-1.5" />}
                    Test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => startEdit(s)}>
                    <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => disconnect(s.id)}>
                    <Unplug className="w-3.5 h-3.5 mr-1.5" /> Remove
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {showForm && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
              {editingId ? 'Edit pod' : 'Add pod'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Talk / Animate / Default"
                className="h-10 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">ComfyUI URL</Label>
              <Input
                value={comfyBaseUrl}
                onChange={e => setComfyBaseUrl(e.target.value)}
                placeholder="https://….proxy.runpod.net"
                className="h-10 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                SSH {editingId && <span className="opacity-60 font-normal">(required to re-validate)</span>}
              </Label>
              <Input
                value={sshCommand}
                onChange={e => setSshCommand(e.target.value)}
                placeholder="ssh user@ssh.runpod.io -i ~/.ssh/id_ed25519"
                className="h-10 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Fish Audio API key{' '}
                {editing?.hasFishApiKey && (
                  <span className="opacity-60 font-normal">(leave blank to keep saved)</span>
                )}
              </Label>
              <Input
                type="password"
                value={fishApiKey}
                onChange={e => setFishApiKey(e.target.value)}
                placeholder={editing?.hasFishApiKey ? '•••••••• (saved)' : 'fish_…'}
                className="h-10 text-sm font-mono"
                autoComplete="off"
              />
            </div>
            <div className="flex gap-2">
              <Button className="flex-1 h-10" onClick={connect} disabled={saving}>
                {saving
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Connecting…</>
                  : <><Plug className="w-4 h-4 mr-2" />{editingId ? 'Save pod' : 'Connect'}</>}
              </Button>
              <Button
                variant="ghost"
                className="h-10"
                onClick={() => { setShowForm(false); setEditingId(null) }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
