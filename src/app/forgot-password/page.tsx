'use client'

import { useState, FormEvent } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, CheckCircle } from 'lucide-react'
import { toast } from 'sonner'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (newPassword.length < 8) { toast.error('Password must be at least 8 characters'); return }
    if (code.length !== 6) { toast.error('Enter the 6-digit 2FA code'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, newPassword }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? 'Reset failed'); return }
      setDone(true)
    } catch {
      toast.error('Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4">
      <div className="relative z-10 w-full max-w-md space-y-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="font-display text-5xl font-bold tracking-tight text-primary">XXmachine</h1>
          <p className="text-[10px] uppercase tracking-[0.3em] font-mono text-muted-foreground">
            AI Content Orchestrator
          </p>
        </div>

        <Card className="glass-card border-white/10 shadow-2xl shadow-black/40 rounded-2xl">
          {done ? (
            <CardContent className="pt-8 pb-8 text-center space-y-4">
              <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto" />
              <p className="font-semibold text-foreground">Password updated</p>
              <p className="text-sm text-muted-foreground">You can now sign in with your new password.</p>
              <Link href="/login">
                <Button className="w-full rounded-xl">Sign in</Button>
              </Link>
            </CardContent>
          ) : (
            <>
              <CardHeader className="space-y-1 pb-4">
                <CardTitle className="text-xl font-display">Reset password</CardTitle>
                <CardDescription>
                  Enter your email, a new password, and your current 2FA code.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Email</Label>
                    <Input
                      type="email"
                      placeholder="your@email.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required
                      className="bg-input border-white/10 h-11 rounded-xl"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">New password</Label>
                    <Input
                      type="password"
                      placeholder="min 8 characters"
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      required
                      className="bg-input border-white/10 h-11 rounded-xl"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">2FA code</Label>
                    <Input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      placeholder="000000"
                      value={code}
                      onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                      className="bg-input border-white/10 h-11 rounded-xl text-center text-xl tracking-[0.4em] font-mono"
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-bold"
                    disabled={busy}
                  >
                    {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Resetting…</> : 'Reset password'}
                  </Button>
                </form>
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  <Link href="/login" className="hover:text-foreground transition-colors">← Back to login</Link>
                </p>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
