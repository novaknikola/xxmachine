'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { Loader2, Plug, PlugZap, RefreshCw, Unplug, CheckCircle2, XCircle } from 'lucide-react'
import { parseRunpodSshCommand } from '@/lib/my-pod/parse-ssh'

interface PodSession {
  connected: boolean
  healthy: boolean
  comfyBaseUrl: string | null
  sshHostMasked: string | null
  sshPort: number | null
  sshUser: string | null
  remoteWorkRoot: string | null
  lastOkAt: string | null
  lastError: string | null
  expiresAt: string | null
}

export function ConnectionTab() {
  const [session, setSession] = useState<PodSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const [comfyBaseUrl, setComfyBaseUrl] = useState('')
  const [sshPaste, setSshPaste] = useState('')
  const [sshHost, setSshHost] = useState('ssh.runpod.io')
  const [sshPort, setSshPort] = useState('22')
  const [sshUser, setSshUser] = useState('')
  const [sshAuthType, setSshAuthType] = useState<'password' | 'private_key'>('private_key')
  const [sshSecret, setSshSecret] = useState('')
  const [comfyApiToken, setComfyApiToken] = useState('')
  const [remoteWorkRoot, setRemoteWorkRoot] = useState('/workspace/xxmachine')

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch('/api/my-pod/session')
      if (res.ok) {
        const d = await res.json()
        setSession(d.session)
        if (d.session?.comfyBaseUrl) setComfyBaseUrl(d.session.comfyBaseUrl)
        if (d.session?.remoteWorkRoot) setRemoteWorkRoot(d.session.remoteWorkRoot)
        if (d.session?.sshUser) setSshUser(d.session.sshUser)
        if (d.session?.sshPort) setSshPort(String(d.session.sshPort))
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSession() }, [fetchSession])

  function applySshPaste(raw: string) {
    setSshPaste(raw)
    const parsed = parseRunpodSshCommand(raw)
    if (!parsed) return
    setSshHost(parsed.sshHost)
    setSshPort(String(parsed.sshPort))
    setSshUser(parsed.sshUser)
    setSshAuthType('private_key')
    toast.success(`Parsed SSH → ${parsed.sshUser}@${parsed.sshHost}`)
  }

  async function connect() {
    if (!comfyBaseUrl.trim() || !sshHost.trim() || !sshUser.trim() || !sshSecret.trim()) {
      toast.error('ComfyUI URL, SSH user/host, and private key are required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/my-pod/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comfyBaseUrl: comfyBaseUrl.trim(),
          sshHost: sshHost.trim(),
          sshPort: Number(sshPort) || 22,
          sshUser: sshUser.trim() || 'root',
          sshAuthType,
          sshSecret,
          comfyApiToken: comfyApiToken.trim() || undefined,
          remoteWorkRoot: remoteWorkRoot.trim() || '/workspace/xxmachine',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Connect failed')
      setSession(data.session)
      setSshSecret('')
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
              From RunPod Connect: paste the <span className="text-foreground">comfy</span> HTTP URL + SSH line below.
              File transfer uses Comfy HTTP (RunPod SSH has no SCP/SFTP).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
            {session?.connected ? 'Update connection' : 'Connect pod'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">ComfyUI URL (HTTP Services → comfy / 8188)</Label>
            <Input
              value={comfyBaseUrl}
              onChange={e => setComfyBaseUrl(e.target.value)}
              placeholder="https://y6i8rlwrcqamk8-8188.proxy.runpod.net"
              className="h-10 text-sm font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Paste SSH command <span className="opacity-60">(optional — auto-fills fields)</span></Label>
            <Input
              value={sshPaste}
              onChange={e => applySshPaste(e.target.value)}
              placeholder="ssh y6i8rlwrcqamk8-64410e02@ssh.runpod.io -i ~/.ssh/id_ed25519"
              className="h-10 text-sm font-mono"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-1">
              <Label className="text-xs text-muted-foreground">SSH host</Label>
              <Input
                value={sshHost}
                onChange={e => setSshHost(e.target.value)}
                placeholder="ssh.runpod.io"
                className="h-10 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Port</Label>
              <Input value={sshPort} onChange={e => setSshPort(e.target.value)} className="h-10 text-sm font-mono" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">SSH user</Label>
              <Input
                value={sshUser}
                onChange={e => setSshUser(e.target.value)}
                placeholder="y6i8rlwrcqamk8-64410e02"
                className="h-10 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Auth</Label>
              <Select value={sshAuthType} onValueChange={v => setSshAuthType(v as 'password' | 'private_key')}>
                <SelectTrigger className="h-10 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="private_key">Private key</SelectItem>
                  <SelectItem value="password">Password</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              {sshAuthType === 'password' ? 'SSH password' : 'SSH private key contents'}
            </Label>
            {sshAuthType === 'password' ? (
              <Input
                type="password"
                value={sshSecret}
                onChange={e => setSshSecret(e.target.value)}
                className="h-10 text-sm font-mono"
              />
            ) : (
              <Textarea
                value={sshSecret}
                onChange={e => setSshSecret(e.target.value)}
                rows={5}
                placeholder={'Paste the full key from your PC:\n-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'}
                className="font-mono text-xs resize-none"
              />
            )}
            <p className="text-[10px] text-muted-foreground">
              `-i ~/.ssh/id_ed25519` means paste that file&apos;s contents here — xxmachine needs the key text, not a path on your laptop.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Comfy API token <span className="opacity-60">(optional)</span></Label>
            <Input
              type="password"
              value={comfyApiToken}
              onChange={e => setComfyApiToken(e.target.value)}
              className="h-10 text-sm font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Remote work root</Label>
            <Input
              value={remoteWorkRoot}
              onChange={e => setRemoteWorkRoot(e.target.value)}
              className="h-10 text-sm font-mono"
            />
          </div>
          <Button className="w-full h-10" onClick={connect} disabled={saving}>
            {saving
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Validating…</>
              : <><Plug className="w-4 h-4 mr-2" />{session?.connected ? 'Reconnect' : 'Connect & validate'}</>}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
