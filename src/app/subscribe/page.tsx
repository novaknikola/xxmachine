'use client'

import { Suspense, useState, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Zap, Check, Loader2, ExternalLink, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

type Plan = 'starter' | 'pro' | 'agency'

const PLANS: { key: Plan; name: string; price: number; highlight?: boolean; features: string[] }[] = [
  {
    key: 'starter',
    name: 'Starter',
    price: 29,
    features: [
      'Up to 10 social accounts',
      'AI content generation',
      'Scheduling & publishing',
      'Unified analytics',
      'BYO API keys',
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    price: 69,
    highlight: true,
    features: [
      'Up to 30 social accounts',
      'Everything in Starter',
      'Image & video spoofer',
      'RunPod automation',
      'Motion & reels pipeline',
    ],
  },
  {
    key: 'agency',
    name: 'Agency',
    price: 149,
    features: [
      'Up to 100 social accounts',
      'Everything in Pro',
      'Priority support',
      'Early access to new features',
      'Custom LoRA training quota',
    ],
  },
]

export default function SubscribePage() {
  return (
    <Suspense fallback={null}>
      <SubscribePageContent />
    </Suspense>
  )
}

function SubscribePageContent() {
  const { user } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [plan, setPlan] = useState<Plan>('pro')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const status = searchParams.get('status')
    if (status === 'success') {
      toast.success('Payment received! Checking subscription status…')
      checkSubscriptionStatus()
    } else if (status === 'failed') {
      toast.error('Payment failed or cancelled. Try again.')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function checkSubscriptionStatus() {
    setChecking(true)
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const res = await fetch('/api/auth/me')
      const data = await res.json()
      if (data.user?.subscription_status === 'active') {
        toast.success('Subscription active! Welcome to XXmachine.')
        router.push('/generate')
        return
      }
    }
    setChecking(false)
    toast.info('Payment processing — it may take a moment to confirm. Refresh the page shortly.')
  }

  async function handleSubscribe() {
    setLoading(true)
    try {
      const res = await fetch('/api/payment/create-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      if (data.paymentLink) {
        window.open(data.paymentLink, '_blank', 'noopener')
        toast.info('Bybit payment opened in a new tab. Return here after payment.')
      }
    } catch (err) {
      toast.error(String(err))
    } finally {
      setLoading(false)
    }
  }

  if (user?.subscription_status === 'active') {
    router.push('/generate')
    return null
  }

  const selected = PLANS.find(p => p.key === plan)!

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4 py-12">
      <div className="relative z-10 w-full max-w-4xl space-y-8">

        {/* Header */}
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/15 border border-primary/25 mx-auto">
            <Zap className="w-5 h-5 text-primary" />
          </div>
          <h1 className="font-display text-3xl font-bold text-foreground">Choose your plan</h1>
          {user && <p className="text-sm text-muted-foreground">Signed in as {user.email}</p>}
          <p className="text-sm text-muted-foreground">Paid via Bybit Pay · USDT · Cancel anytime</p>
        </div>

        {/* Plan cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {PLANS.map(p => (
            <button
              key={p.key}
              onClick={() => setPlan(p.key)}
              className={`relative text-left glass-card rounded-2xl p-6 space-y-4 transition-all border-2 ${
                plan === p.key
                  ? 'border-primary shadow-lg shadow-primary/10'
                  : 'border-transparent hover:border-border'
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] bg-primary text-primary-foreground px-3 py-0.5 rounded-full font-bold tracking-wide">
                  MOST POPULAR
                </span>
              )}
              <div>
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-widest mb-1">{p.name}</p>
                <div className="flex items-baseline gap-1">
                  <span className="font-display text-4xl font-bold text-foreground">${p.price}</span>
                  <span className="text-muted-foreground text-sm">/ mo</span>
                </div>
              </div>
              <ul className="space-y-2">
                {p.features.map(f => (
                  <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    {f}
                  </li>
                ))}
              </ul>
              {plan === p.key && (
                <div className="absolute top-4 right-4 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                  <Check className="w-2.5 h-2.5 text-primary-foreground" />
                </div>
              )}
            </button>
          ))}
        </div>

        {/* CTA */}
        <div className="max-w-sm mx-auto space-y-3">
          <Button
            onClick={handleSubscribe}
            disabled={loading || checking}
            className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-bold text-base glow-primary"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-2" />Opening payment…</>
            ) : checking ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-2" />Confirming payment…</>
            ) : (
              <><ExternalLink className="w-4 h-4 mr-2" />Subscribe to {selected.name} — ${selected.price}/mo</>
            )}
          </Button>

          <button
            onClick={checkSubscriptionStatus}
            disabled={checking}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mx-auto"
          >
            <RefreshCw className="w-3 h-3" />
            I already paid — check my subscription
          </button>
        </div>

      </div>
    </div>
  )
}
