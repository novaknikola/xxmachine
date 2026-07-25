'use client'

import { useState, useEffect, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, ShieldCheck, Zap } from 'lucide-react'
import { toast } from 'sonner'

type Step = 'credentials' | '2fa'

export default function LoginPage() {
  const router = useRouter()
  const { login, verify2fa, user, loading } = useAuth()

  useEffect(() => {
    if (!loading && user) router.replace('/generate')
  }, [user, loading, router])

  const [step, setStep] = useState<Step>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [userId, setUserId] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleCredentials(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    const result = await login(email, password)
    setBusy(false)

    if (result.requires2fa && result.userId) {
      setUserId(result.userId)
      setStep('2fa')
      return
    }
    if (result.ok) {
      router.push('/generate')
      return
    }
    toast.error('Invalid email or password')
  }

  async function handle2fa(e: FormEvent) {
    e.preventDefault()
    if (code.length !== 6) { toast.error('Enter the 6-digit code'); return }
    setBusy(true)
    const ok = await verify2fa(userId, code)
    setBusy(false)
    if (ok) {
      router.push('/generate')
    } else {
      toast.error('Invalid or expired code')
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
          {step === 'credentials' ? (
            <>
              <CardHeader className="space-y-1 pb-4">
                <CardTitle className="text-xl font-display">Sign in</CardTitle>
                <CardDescription>Enter your credentials to access the orchestrator.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCredentials} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-xs uppercase tracking-wider text-muted-foreground">Email</Label>
                    <Input
                      id="email"
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
                    <Label htmlFor="password" className="text-xs uppercase tracking-wider text-muted-foreground">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      className="bg-input border-white/10 h-11 rounded-xl"
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-bold glow-primary"
                    disabled={busy}
                  >
                    {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Signing in…</> : 'Sign in'}
                  </Button>
                </form>
                <div className="mt-4 text-center space-y-1">
                  <p className="text-xs text-muted-foreground">
                    No account?{' '}
                    <Link href="/signup" className="text-primary hover:underline">Create one</Link>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <Link href="/forgot-password" className="hover:underline">Forgot password?</Link>
                  </p>
                </div>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className="space-y-1 pb-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-primary" />
                  <CardTitle className="text-xl font-display">Two-factor auth</CardTitle>
                </div>
                <CardDescription>Enter the 6-digit code from your authenticator app.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handle2fa} className="space-y-4">
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
                  <Button
                    type="submit"
                    className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-bold"
                    disabled={busy || code.length !== 6}
                  >
                    {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</> : 'Verify'}
                  </Button>
                  <button
                    type="button"
                    onClick={() => { setStep('credentials'); setCode('') }}
                    className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    ← Back to login
                  </button>
                </form>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
