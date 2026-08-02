'use client'

import { useState, useEffect, useRef } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import {
  User,
  Key,
  Save,
  Loader2,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Zap,
  Circle,
  HardDrive,
  ExternalLink,
  Unplug,
  Upload,
  Image as ImageIcon,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────

interface SettingsData {
  profile: {
    display_name: string
    telegram: string
    totp_enabled: boolean
    subscription_status: string
  }
  apiKeys: Record<string, boolean>
}

const API_KEY_LABELS: Record<string, string> = {
  wavespeed_api_key: 'Wavespeed API Key',
  hf_token: 'Hugging Face Token',
  apify_api_key: 'Apify API Key',
  ig_app_id: 'Instagram App ID',
  ig_app_secret: 'Instagram App Secret',
  threads_app_id: 'Threads App ID',
  threads_app_secret: 'Threads App Secret',
}

const API_KEY_FIELDS = Object.keys(API_KEY_LABELS) as (keyof typeof API_KEY_LABELS)[]

// ─── Sub-components ───────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ElementType
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
        active
          ? 'bg-primary/10 text-primary border border-primary/20'
          : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
      }`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  )
}

// ─── Profile Tab ─────────────────────────────────────────────────

function ProfileTab({ initialData }: { initialData: SettingsData['profile'] }) {
  const [displayName, setDisplayName] = useState(initialData.display_name)
  const [telegram, setTelegram] = useState(initialData.telegram)
  const [savingProfile, setSavingProfile] = useState(false)

  const [newPassword, setNewPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)

  async function saveProfile() {
    setSavingProfile(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'profile', display_name: displayName, telegram }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Profile updated')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSavingProfile(false)
    }
  }

  async function changePassword() {
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
    if (!totpCode || totpCode.length !== 6) {
      toast.error('Enter your 6-digit 2FA code')
      return
    }
    setSavingPassword(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'password', newPassword, totpCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Password changed successfully')
      setNewPassword('')
      setTotpCode('')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSavingPassword(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Account info */}
      <div className="glass-card rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Account Info</h3>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Display Name</label>
            <Input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Your name"
              className="bg-secondary/50 border-border"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Telegram Handle</label>
            <Input
              value={telegram}
              onChange={e => setTelegram(e.target.value)}
              placeholder="@username"
              className="bg-secondary/50 border-border"
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {initialData.totp_enabled ? (
              <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> 2FA enabled</>
            ) : (
              <><XCircle className="w-3.5 h-3.5 text-destructive" /> 2FA not active</>
            )}
          </div>
          <Button
            onClick={saveProfile}
            disabled={savingProfile}
            size="sm"
            className="h-8"
          >
            {savingProfile ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
            Save profile
          </Button>
        </div>
      </div>

      {/* Change password */}
      <div className="glass-card rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Change Password</h3>
        <p className="text-xs text-muted-foreground">
          Requires your current authenticator code to confirm identity.
        </p>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">New Password</label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Min. 8 characters"
                className="bg-secondary/50 border-border pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">2FA Code (from authenticator app)</label>
            <Input
              value={totpCode}
              onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              className="bg-secondary/50 border-border font-mono tracking-[0.5em] text-center"
            />
          </div>
        </div>
        <Button
          onClick={changePassword}
          disabled={savingPassword || !newPassword || totpCode.length !== 6}
          size="sm"
          variant="outline"
          className="h-8"
        >
          {savingPassword ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Key className="w-3.5 h-3.5 mr-1.5" />}
          Change password
        </Button>
      </div>
    </div>
  )
}

// ─── API Keys Tab ─────────────────────────────────────────────────

function ApiKeysTab({ initialPresence }: { initialPresence: Record<string, boolean> }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)

  function toggle(field: string) {
    setVisible(v => ({ ...v, [field]: !v[field] }))
  }

  async function saveKeys() {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'api_keys', ...values }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('API keys saved')
      setValues({})
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = Object.values(values).some(v => v.trim() !== '')

  return (
    <div className="glass-card rounded-2xl p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">API Keys</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Stored encrypted. Leave blank to keep existing key. Clear a field and save to remove it.
          </p>
        </div>
        <Button
          onClick={saveKeys}
          disabled={saving || !hasChanges}
          size="sm"
          className="h-8 shrink-0"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
          Save keys
        </Button>
      </div>

      <div className="grid gap-3">
        {API_KEY_FIELDS.map(field => (
          <div key={field} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground flex-1">{API_KEY_LABELS[field]}</label>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                  initialPresence[field]
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-secondary text-muted-foreground'
                }`}
              >
                {initialPresence[field] ? 'Set' : 'Not set'}
              </span>
            </div>
            <div className="relative">
              <Input
                type={visible[field] ? 'text' : 'password'}
                value={values[field] ?? ''}
                onChange={e => setValues(v => ({ ...v, [field]: e.target.value }))}
                placeholder={initialPresence[field] ? '••••••••••••••••' : 'Enter key…'}
                className="bg-secondary/50 border-border pr-10 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => toggle(field)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {visible[field] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Content Engine Tab ──────────────────────────────────────────

interface ByokKeyStatus {
  name: string
  label: string
  placeholder: string
  required: boolean
  isSet: boolean
}

function ContentEngineTab() {
  const [keys, setKeys]       = useState<ByokKeyStatus[]>([])
  const [values, setValues]   = useState<Record<string, string>>({})
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)

  useEffect(() => {
    fetch('/api/settings/keys')
      .then(r => r.json())
      .then(d => { setKeys(d.keys ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  async function saveKeys() {
    setSaving(true)
    try {
      const payload = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''))
      const res = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('Save failed')
      const updated = await fetch('/api/settings/keys').then(r => r.json())
      setKeys(updated.keys ?? [])
      setValues({})
      toast.success('Content Engine keys saved')
    } catch {
      toast.error('Error saving keys')
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = Object.values(values).some(v => v !== '')
  const allRequired = keys.filter(k => k.required).every(k => k.isSet || values[k.name])

  return (
    <div className="space-y-4">
      <div className="glass-card rounded-2xl p-6 space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" /> RunPod Content Engine
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Serverless endpoint keys for the discovery pipeline. For dedicated Pod + ComfyUI, use{' '}
              <a href="/my-pod?tab=connection" className="text-primary hover:underline">My Pod → Connection</a>.
              {' '}Each user pays their own API costs directly to the providers.
            </p>
          </div>
          <Button onClick={saveKeys} disabled={saving || !hasChanges} size="sm" className="h-8 shrink-0">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
            Save
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid gap-3">
            {keys.map(k => (
              <div key={k.name} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground flex-1">{k.label}</label>
                  {k.required && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium">required</span>
                  )}
                  {(k.isSet && !values[k.name]) ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium flex items-center gap-1">
                      <CheckCircle2 className="w-2.5 h-2.5" /> Set
                    </span>
                  ) : (!k.isSet && !values[k.name]) ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium flex items-center gap-1">
                      <Circle className="w-2.5 h-2.5" /> Not set
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">Unsaved</span>
                  )}
                </div>
                <div className="relative">
                  <Input
                    type={visible[k.name] ? 'text' : 'password'}
                    placeholder={k.isSet ? '••••••••••••••••' : k.placeholder}
                    value={values[k.name] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [k.name]: e.target.value }))}
                    className="bg-secondary/50 border-border pr-10 font-mono text-xs"
                  />
                  <button type="button" onClick={() => setVisible(v => ({ ...v, [k.name]: !v[k.name] }))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {visible[k.name] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && (
          <div className={`rounded-xl px-4 py-3 text-xs flex items-center gap-2 ${
            allRequired
              ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
              : 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
          }`}>
            {allRequired
              ? <><CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Content Engine is ready to use.</>
              : <><Circle className="w-3.5 h-3.5 shrink-0" /> Set the required keys to activate Content Engine.</>
            }
          </div>
        )}
      </div>

      <DefaultReferencePhoto />

      <div className="glass-card rounded-2xl p-5 space-y-3 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground text-sm">Where to find the keys</p>
        <ul className="space-y-1.5">
          <li>• <span className="text-foreground">RunPod API Key</span> — runpod.io → Settings → API Keys</li>
          <li>• <span className="text-foreground">RapidAPI Key</span> — rapidapi.com → Apps → subscribe to Instagram Scraper + TikTok Scraper</li>
          <li>• <span className="text-foreground">RunPod Endpoints</span> — Serverless → Endpoints (copy the ID from the URL)</li>
          <li>• <span className="text-foreground">Google Drive Folder ID</span> — from the folder URL (/folders/&lt;ID&gt;)</li>
        </ul>
      </div>
    </div>
  )
}

// ─── Copy-Paste default reference photo ───────────────────────────

/**
 * Identity fallback for reels that arrive from a profile scan rather than a
 * manual paste — those have no per-batch photo, so without this the whole
 * scan → approve → replicate loop cannot run unattended.
 */
function DefaultReferencePhoto() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => { setUrl(d.copyPaste?.default_reference_image_url ?? null); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  async function save(next: string | null) {
    setBusy(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'copy_paste', default_reference_image_url: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      setUrl(next)
      toast.success(next ? 'Default reference photo saved' : 'Default reference photo removed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function onPick(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    try {
      const res = await fetch('/api/queue/upload-input', {
        method: 'POST',
        headers: {
          'content-type': file.type || 'image/jpeg',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      await save(data.url as string)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
      setBusy(false)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="glass-card rounded-2xl p-6 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-primary" /> Copy-Paste default reference photo
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Used when a reel comes from a tracked-profile scan instead of a manual paste.
          A photo uploaded with a batch always wins over this one.
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        className="hidden"
        onChange={e => onPick(e.target.files)}
      />

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : url ? (
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" className="w-24 aspect-square object-cover rounded-xl border border-border" />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
              Replace
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => save(null)}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="w-full border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
          <span className="text-sm">{busy ? 'Uploading…' : 'Upload default reference photo'}</span>
          <span className="text-xs opacity-60">JPEG, PNG or WebP</span>
        </button>
      )}
    </div>
  )
}

// ─── Drive Archive Tab ────────────────────────────────────────────

interface DriveArchiveStatus {
  connected: boolean
  autoArchive: boolean
  rootFolderId: string | null
  rootFolderUrl: string | null
  pendingExports: number
}

function DriveArchiveTab() {
  const [status, setStatus] = useState<DriveArchiveStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/settings/drive-archive')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load')
      setStatus(data)
    } catch (err) {
      toast.error(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function toggleArchive(enabled: boolean) {
    setBusy(true)
    try {
      const res = await fetch('/api/settings/drive-archive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', autoArchive: enabled }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setStatus(s => (s ? { ...s, autoArchive: data.autoArchive } : s))
      toast.success(enabled ? 'Auto-archive enabled' : 'Auto-archive disabled')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      const res = await fetch('/api/settings/drive-archive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setStatus({
        connected: false,
        autoArchive: false,
        rootFolderId: null,
        rootFolderUrl: null,
        pendingExports: 0,
      })
      toast.success('Google Drive disconnected')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function ensureRoot() {
    setBusy(true)
    try {
      const res = await fetch('/api/settings/drive-archive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ensure_root' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setStatus(s =>
        s
          ? {
              ...s,
              rootFolderId: data.rootFolderId,
              rootFolderUrl: data.rootFolderUrl,
            }
          : s,
      )
      toast.success('Archive folder ready')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="glass-card rounded-2xl p-6 space-y-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-primary" /> Google Drive archive
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Automatically copy finished generations into your Drive under
            {' '}<span className="text-foreground">XXMachine Archives</span>
            {' '}(by character → type → AI model). Uploads run in the background — no local download needed.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
              status?.connected
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-secondary text-muted-foreground'
            }`}
          >
            {status?.connected ? 'Connected' : 'Not connected'}
          </span>
          {status?.connected && (
            <span className="text-[10px] text-muted-foreground">
              {status.pendingExports} pending upload{status.pendingExports === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {!status?.connected ? (
          <a
            href="/api/google/auth?purpose=archive"
            className={buttonVariants({ size: 'sm', className: 'h-8' })}
          >
            Connect Google Drive
          </a>
        ) : (
          <div className="space-y-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 accent-primary"
                checked={status.autoArchive}
                disabled={busy}
                onChange={e => toggleArchive(e.target.checked)}
              />
              <span>
                <span className="text-sm text-foreground">Auto-archive generations</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  When on, finished Image Studio and Copy-Paste outputs are uploaded to Drive in the background.
                </span>
              </span>
            </label>

            <div className="flex flex-wrap gap-2">
              {status.rootFolderUrl ? (
                <a
                  href={status.rootFolderUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ size: 'sm', variant: 'outline', className: 'h-8' })}
                >
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                  Open archive folder
                </a>
              ) : (
                <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={ensureRoot}>
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                  Create archive folder
                </Button>
              )}
              <a
                href="/api/google/auth?purpose=archive"
                className={buttonVariants({ size: 'sm', variant: 'outline', className: 'h-8' })}
              >
                Reconnect
              </a>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-destructive hover:text-destructive"
                disabled={busy}
                onClick={disconnect}
              >
                <Unplug className="w-3.5 h-3.5 mr-1.5" />
                Disconnect
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="glass-card rounded-2xl p-5 space-y-2 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground text-sm">How it works</p>
        <ul className="space-y-1.5">
          <li>• Files stay in app storage; Drive gets a copy after generation finishes.</li>
          <li>• Folder layout: girl → stories|carousel|video → ready|raw → YYYY-MM-DD (AI model in filename).</li>
          <li>• Pick Story / Carousel / Video + Drive folder (girl) when generating — creates the folder if missing.</li>
          <li>• Images and Copy-Paste videos auto-repurpose into ready/; originals only in raw/. Failures retry then skip (never original in ready/).</li>
          <li>• Uploads run on the server (cron + kick after enqueue).</li>
        </ul>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────

type Tab = 'profile' | 'api_keys' | 'content_engine' | 'drive'

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('profile')
  const [data, setData] = useState<SettingsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('tab') === 'drive') setTab('drive')
    if (params.get('google_connected') === '1') {
      toast.success('Google Drive connected — auto-archive enabled')
      window.history.replaceState({}, '', '/settings?tab=drive')
    }
    const err = params.get('google_error')
    if (err) {
      toast.error(`Google Drive: ${err}`)
      window.history.replaceState({}, '', '/settings?tab=drive')
    }
  }, [])

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:px-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your profile, API keys, and Drive archive
        </p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        <TabButton active={tab === 'profile'} onClick={() => setTab('profile')} icon={User} label="Profile" />
        <TabButton active={tab === 'api_keys'} onClick={() => setTab('api_keys')} icon={Key} label="API Keys" />
        <TabButton active={tab === 'content_engine'} onClick={() => setTab('content_engine')} icon={Zap} label="Content Engine" />
        <TabButton active={tab === 'drive'} onClick={() => setTab('drive')} icon={HardDrive} label="Drive" />
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !data ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Failed to load settings</div>
      ) : (
        <>
          {tab === 'profile' && <ProfileTab initialData={data.profile} />}
          {tab === 'api_keys' && <ApiKeysTab initialPresence={data.apiKeys} />}
          {tab === 'content_engine' && <ContentEngineTab />}
          {tab === 'drive' && <DriveArchiveTab />}
        </>
      )}
    </div>
  )
}
