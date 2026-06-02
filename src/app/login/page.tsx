'use client'

import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export default function LoginPage() {
  const router = useRouter()
  const { login, bootstrap, needsBootstrap, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    let ok = false
    if (needsBootstrap) {
      if (!name.trim()) {
        toast.error('Display name is required')
        setBusy(false)
        return
      }
      if (password.length < 8) {
        toast.error('Password must be at least 8 characters')
        setBusy(false)
        return
      }
      ok = await bootstrap(email, password, name.trim())
      if (!ok) toast.error('Bootstrap failed — check server logs')
    } else {
      ok = await login(email, password)
      if (!ok) toast.error('Invalid email or password')
    }
    setBusy(false)
    if (ok) router.push('/generate')
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
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-xl font-display">
              {needsBootstrap ? 'Create admin account' : 'Sign in'}
            </CardTitle>
            <CardDescription>
              {needsBootstrap
                ? 'No users yet — first signup becomes the admin.'
                : 'Enter your credentials to access the orchestrator.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {needsBootstrap && (
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-xs uppercase tracking-wider text-muted-foreground">Display name</Label>
                  <Input
                    id="name"
                    type="text"
                    placeholder="Your name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    required
                    autoComplete="name"
                    className="bg-input border-white/10 h-11 rounded-xl"
                  />
                </div>
              )}
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
                  placeholder={needsBootstrap ? 'min 8 chars' : '••••••••'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
                  className="bg-input border-white/10 h-11 rounded-xl"
                />
              </div>
              <Button
                type="submit"
                className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-bold glow-primary"
                disabled={busy}
              >
                {busy ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {needsBootstrap ? 'Creating…' : 'Signing in…'}
                  </>
                ) : (
                  needsBootstrap ? 'Create admin & sign in' : 'Sign in'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
