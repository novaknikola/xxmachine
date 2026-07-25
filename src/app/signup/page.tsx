'use client'

import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, ShieldCheck, Download, Zap } from 'lucide-react'
import { toast } from 'sonner'

type Step = 'form' | 'qr'

export default function SignupPage() {
  const router = useRouter()
  const { verify2fa } = useAuth()

  const [step, setStep] = useState<Step>('form')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [telegram, setTelegram] = useState('')
  const [busy, setBusy] = useState(false)

  // QR step state
  const [userId, setUserId] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [otpauthUrl, setOtpauthUrl] = useState('')
  const [code, setCode] = useState('')

  async function handleRegister(e: FormEvent) {
    e.preventDefault()
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, display_name: displayName, telegram }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error === 'email_taken' ? 'This email is already registered' : 'Registration failed')
        return
      }
      setUserId(data.userId)
      setQrDataUrl(data.qrDataUrl)
      setOtpauthUrl(data.otpauthUrl)
      setStep('qr')
    } catch {
      toast.error('Network error — try again')
    } finally {
      setBusy(false)
    }
  }

  async function handle2fa(e: FormEvent) {
    e.preventDefault()
    if (code.length !== 6) { toast.error('Enter the 6-digit code'); return }
    setBusy(true)
    const ok = await verify2fa(userId, code, '/api/auth/signup/verify')
    setBusy(false)
    if (ok) {
      toast.success('Account created! Welcome to XXmachine.')
      router.push('/subscribe')
    } else {
      toast.error('Invalid code — try again')
      setCode('')
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4">
      {/* Ambient glows */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full blur-[120px] bg-primary/10" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] rounded-full blur-[120px] bg-purple-500/10" />
      </div>

      <div className="relative z-10 w-full max-w-md space-y-8">
        <Link href="/" className="flex items-center justify-center gap-2">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/15 border border-primary/25">
            <Zap className="w-4.5 h-4.5 text-primary" />
          </div>
          <span className="font-display font-bold text-lg text-foreground">XXmachine</span>
        </Link>

        <Card className="glass-card border-white/10 shadow-2xl shadow-black/40 rounded-2xl">
          {step === 'form' ? (
            <>
              <CardHeader className="space-y-1 pb-4">
                <CardTitle className="text-xl font-display">Create account</CardTitle>
                <CardDescription>2FA is required for all accounts.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleRegister} className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Display name</Label>
                    <Input
                      type="text"
                      placeholder="Your name"
                      value={displayName}
                      onChange={e => setDisplayName(e.target.value)}
                      required
                      autoComplete="name"
                      className="bg-input border-white/10 h-11 rounded-xl"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Email</Label>
                    <Input
                      type="email"
                      placeholder="your@email.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required
                      autoComplete="email"
                      className="bg-input border-white/10 h-11 rounded-xl"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Password</Label>
                    <Input
                      type="password"
                      placeholder="min 8 characters"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      autoComplete="new-password"
                      className="bg-input border-white/10 h-11 rounded-xl"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                      Telegram <span className="text-muted-foreground/60 normal-case">(optional)</span>
                    </Label>
                    <Input
                      type="text"
                      placeholder="@username"
                      value={telegram}
                      onChange={e => setTelegram(e.target.value)}
                      className="bg-input border-white/10 h-11 rounded-xl"
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-bold glow-primary"
                    disabled={busy}
                  >
                    {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating…</> : 'Continue'}
                  </Button>
                </form>
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  Already have an account?{' '}
                  <Link href="/login" className="text-primary hover:underline">Sign in</Link>
                </p>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className="space-y-1 pb-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-primary" />
                  <CardTitle className="text-xl font-display">Set up 2FA</CardTitle>
                </div>
                <CardDescription>
                  Scan this QR code with Google Authenticator, Authy, or any TOTP app.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handle2fa} className="space-y-5">
                  {/* QR code */}
                  <div className="flex flex-col items-center gap-3">
                    {qrDataUrl && (
                      <div className="p-3 bg-white rounded-xl">
                        <img src={qrDataUrl} alt="2FA QR Code" className="w-44 h-44" />
                      </div>
                    )}
                    {otpauthUrl && (
                      <a
                        href={otpauthUrl}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        title="Open in authenticator app"
                      >
                        <Download className="w-3 h-3" />
                        Open in authenticator app
                      </a>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                      Enter the 6-digit code to confirm
                    </Label>
                    <Input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      placeholder="000000"
                      value={code}
                      onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                      autoFocus
                      className="bg-input border-white/10 h-11 rounded-xl text-center text-2xl tracking-[0.5em] font-mono"
                    />
                  </div>

                  <Button
                    type="submit"
                    className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-bold"
                    disabled={busy || code.length !== 6}
                  >
                    {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</> : 'Activate 2FA & continue'}
                  </Button>
                </form>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
