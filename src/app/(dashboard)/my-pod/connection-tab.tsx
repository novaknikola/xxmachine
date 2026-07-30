'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { Loader2, Plug, PlugZap, RefreshCw, Unplug, CheckCircle2, XCircle } from 'lucide-react'

interface PodSession {
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
  const [session, setSession] = useState<PodSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [comfyBaseUrl, setComfyBaseUrl] = useState('')
  const [sshCommand, setSshCommand] = useState('')
  const [fishApiKey, setFishApiKey] = useState('')

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch('/api/my-pod/session')
      if (res.ok) {
        const d = await res.json()
        setSession(d.session)
        if (d.session?.comfyBaseUrl) setComfyBaseUrl(d.session.comfyBaseUrl)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSession() }, [fetchSession])

  async function connect() {
    if (!comfyBaseUrl.trim() || !sshCommand.trim()) {
      toast.error('Paste ComfyUI URL and SSH command')
      return
    }
    if (!fishApiKey.trim() && !session?.hasFishApiKey) {
      toast.error('Paste your Fish Audio API key (needed for Talk)')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/my-pod/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comfyBaseUrl: comfyBaseUrl.trim(),
          sshCommand: sshCommand.trim(),
          fishApiKey: fishApiKey.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Connect failed')
      setSession(data.session)
      setFishApiKey('')
      toast.success('Pod connected')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setTesting(true)
    try {
      const res = await fetch('/api/my-pod/session/test', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Test failed')
      setSession(data.session)
      toast.success('Connection healthy')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed')
      fetchSession()
    } finally {
      setTesting(false)
    }
  }

  async function disconnect() {
    const res = await fetch('/api/my-pod/session', { method: 'DELETE' })
    if (res.ok) {
      setSession(null)
      setFishApiKey('')
      toast.success('Disconnected')
    } else {
      toast.error('Could not disconnect')
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
            Status
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={fetchSession}>
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {session?.connected ? (
            <>
              <div className="flex items-center gap-2">
                {session.healthy
                  ? <><CheckCircle2 className="w-4 h-4 text-emerald-400" /><span className="text-emerald-400">Online</span></>
                  : <><XCircle className="w-4 h-4 text-destructive" /><span className="text-destructive">Unhealthy</span></>}
              </div>
              <p className="text-xs text-muted-foreground font-mono break-all">{session.comfyBaseUrl}</p>
              <p className="text-xs text-muted-foreground">
                SSH {session.sshUser}@{session.sshHostMasked}:{session.sshPort}
              </p>
              <p className="text-xs text-muted-foreground">
                Fish API key: {session.hasFishApiKey ? 'saved' : 'missing (required for Talk)'}
              </p>
              {session.lastOkAt && (
                <p className="text-xs text-muted-foreground">Last OK: {new Date(session.lastOkAt).toLocaleString()}</p>
              )}
              {session.lastError && (
                <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2 font-mono break-all">{session.lastError}</p>
              )}
              <div className="flex gap-2 pt-2">
                <Button size="sm" variant="outline" onClick={test} disabled={testing}>
                  {testing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5 mr-1.5" />}
                  Test
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={disconnect}>
                  <Unplug className="w-3.5 h-3.5 mr-1.5" /> Disconnect
                </Button>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Paste ComfyUI URL + SSH from RunPod Connect, plus your Fish Audio API key for Talk.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
            Connect
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">ComfyUI URL</Label>
            <Input
              value={comfyBaseUrl}
              onChange={e => setComfyBaseUrl(e.target.value)}
              placeholder="https://y6i8rlwrcqamk8-8188.proxy.runpod.net"
              className="h-10 text-sm font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">SSH</Label>
            <Input
              value={sshCommand}
              onChange={e => setSshCommand(e.target.value)}
              placeholder="ssh y6i8rlwrcqamk8-64410e02@ssh.runpod.io -i ~/.ssh/id_ed25519"
              className="h-10 text-sm font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Fish Audio API key{' '}
              {session?.hasFishApiKey && (
                <span className="opacity-60 font-normal">(leave blank to keep saved)</span>
              )}
            </Label>
            <Input
              type="password"
              value={fishApiKey}
              onChange={e => setFishApiKey(e.target.value)}
              placeholder={session?.hasFishApiKey ? '•••••••• (saved)' : 'fish_…'}
              className="h-10 text-sm font-mono"
              autoComplete="off"
            />
          </div>
          <Button className="w-full h-10" onClick={connect} disabled={saving}>
            {saving
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Connecting…</>
              : <><Plug className="w-4 h-4 mr-2" />Connect</>}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
