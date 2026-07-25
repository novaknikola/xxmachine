'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Zap,
  ImageIcon,
  BarChart2,
  Shuffle,
  Server,
  Globe,
  ArrowRight,
  Sparkles,
  Film,
  Menu,
  X,
} from 'lucide-react'

// ─── Feature data ────────────────────────────────────────────

const FEATURES = [
  {
    icon: ImageIcon,
    title: 'AI Image Generation',
    desc: 'Generate high-quality content with custom LoRA models and WAN video pipelines. Batch-produce weeks of content in minutes.',
  },
  {
    icon: Globe,
    title: 'Multi-Platform Publishing',
    desc: 'Schedule and auto-publish to Instagram, Threads, TikTok, and Twitter/X from one place. No manual uploads, no context switching.',
  },
  {
    icon: BarChart2,
    title: 'Unified Analytics',
    desc: 'Track followers, views, and performance across all your accounts and platforms on a single dashboard.',
  },
  {
    icon: Shuffle,
    title: 'Image & Video Spoofer',
    desc: 'Automatically alter metadata, apply subtle visual transforms, and randomise fingerprints so every post looks unique to platform algorithms.',
  },
  {
    icon: Server,
    title: 'RunPod Automation',
    desc: 'Spin up GPU pods on demand, run ComfyUI workflows remotely, and pull results back — all without leaving the dashboard.',
  },
  {
    icon: Film,
    title: 'Motion & Reels',
    desc: 'Turn static images into viral-ready video content. Scan trending reels, replicate them, and push to every account automatically.',
  },
]

const STEPS = [
  {
    num: '01',
    title: 'Connect your accounts',
    desc: 'Link Instagram, Threads, TikTok, and Twitter via OAuth or username in under two minutes.',
  },
  {
    num: '02',
    title: 'Generate & schedule content',
    desc: 'Use AI to create images and captions, arrange them on the calendar, and approve the queue.',
  },
  {
    num: '03',
    title: 'Monitor from one dashboard',
    desc: 'Watch follower growth, views, and earnings update daily — across every account, every platform.',
  },
]

// ─── Components ──────────────────────────────────────────────

function NavBar() {
  const [open, setOpen] = useState(false)
  return (
    <nav className="fixed top-0 inset-x-0 z-50 border-b border-white/8 bg-background/70 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/15 border border-primary/25">
            <Zap className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="font-display font-bold text-base tracking-tight text-foreground">XXmachine</span>
        </div>

        {/* Desktop nav */}
        <div className="hidden sm:flex items-center gap-3">
          <Link href="/privacy" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Privacy</Link>
          <Link href="/terms" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Terms</Link>
          <Link href="/login" className="text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity px-4 py-1.5 rounded-lg">
            Sign in
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button className="sm:hidden p-2 text-foreground" onClick={() => setOpen(!open)}>
          {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="sm:hidden border-t border-white/8 bg-background/95 backdrop-blur-xl px-6 py-4 space-y-3">
          <Link href="/privacy" className="block text-sm text-muted-foreground hover:text-foreground transition-colors py-1" onClick={() => setOpen(false)}>Privacy</Link>
          <Link href="/terms" className="block text-sm text-muted-foreground hover:text-foreground transition-colors py-1" onClick={() => setOpen(false)}>Terms</Link>
          <Link href="/login" className="block text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity px-4 py-2 rounded-lg text-center" onClick={() => setOpen(false)}>
            Sign in
          </Link>
        </div>
      )}
    </nav>
  )
}

function HeroSection() {
  return (
    <section className="relative pt-32 pb-24 px-6 text-center">
      <div className="max-w-4xl mx-auto">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/25 bg-primary/8 text-primary text-xs font-medium mb-8">
          <Sparkles className="w-3 h-3" />
          AI-powered content orchestration
        </div>

        <h1 className="font-display text-4xl sm:text-5xl lg:text-7xl font-bold leading-tight tracking-tight text-foreground mb-6">
          Mass create & manage.
          <br />
          <span className="text-primary">From one place.</span>
        </h1>

        <p className="text-base sm:text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed px-2">
          XXmachine automates AI content generation, multi-platform scheduling,
          and fan analytics for agencies running 10, 20, or 100+ social accounts.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/signup"
            className="flex items-center gap-2 bg-primary text-primary-foreground font-semibold px-6 py-3 rounded-xl hover:opacity-90 transition-opacity text-sm"
          >
            Get started
            <ArrowRight className="w-4 h-4" />
          </Link>
          <a
            href="#features"
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors px-6 py-3"
          >
            See features
          </a>
        </div>

        {/* Stats bar */}
        <div className="mt-12 sm:mt-16 flex flex-wrap items-center justify-center gap-6 sm:gap-12 text-center">
          {[
            { val: '4', label: 'Platforms' },
            { val: '∞', label: 'Accounts' },
            { val: '1', label: 'Dashboard' },
          ].map(s => (
            <div key={s.label}>
              <p className="font-display text-3xl font-bold text-foreground">{s.val}</p>
              <p className="text-xs text-muted-foreground mt-1 uppercase tracking-widest">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Dashboard preview mockup */}
        <div className="mt-16 glass-card rounded-2xl p-4 sm:p-8 max-w-5xl mx-auto">
          <div className="aspect-video bg-gradient-to-br from-primary/5 to-purple-500/5 rounded-lg border border-white/8 flex items-center justify-center">
            <div className="text-center">
              <BarChart2 className="w-12 h-12 sm:w-16 sm:h-16 text-primary/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Dashboard Preview</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function FeaturesSection() {
  return (
    <section id="features" className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Everything your team needs
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Built for agencies that manage multiple creators across multiple platforms — without losing their minds.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map(f => {
            const Icon = f.icon
            return (
              <div key={f.title} className="glass-card rounded-2xl p-6 hover:border-primary/20 transition-colors">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/12 border border-primary/20 mb-4">
                  <Icon className="w-5 h-5 text-primary" />
                </div>
                <h3 className="font-semibold text-foreground mb-2">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function HowItWorksSection() {
  return (
    <section className="py-24 px-6">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            How it works
          </h2>
          <p className="text-muted-foreground">Three steps from zero to fully automated.</p>
        </div>

        <div className="relative">
          {/* Connector line */}
          <div className="hidden sm:block absolute left-[calc(2.5rem-1px)] top-10 bottom-10 w-px bg-gradient-to-b from-primary/40 via-primary/20 to-transparent" />

          <div className="space-y-10">
            {STEPS.map(s => (
              <div key={s.num} className="flex gap-6">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center z-10">
                  <span className="text-xs font-bold text-primary font-mono">{s.num}</span>
                </div>
                <div className="pt-1.5">
                  <h3 className="font-semibold text-foreground mb-1">{s.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

const PRICING_TIERS = [
  {
    name: 'Starter',
    price: 29,
    highlight: false,
    features: ['Up to 10 social accounts', 'AI content generation', 'Scheduling & publishing', 'Unified analytics', 'BYO API keys'],
  },
  {
    name: 'Pro',
    price: 69,
    highlight: true,
    features: ['Up to 30 social accounts', 'Everything in Starter', 'Image & video spoofer', 'RunPod automation', 'Motion & reels pipeline'],
  },
  {
    name: 'Agency',
    price: 149,
    highlight: false,
    features: ['Up to 100 social accounts', 'Everything in Pro', 'Priority support', 'Early access to features', 'Custom LoRA quota'],
  },
]

function PricingSection() {
  return (
    <section className="py-24 px-6 border-t border-white/5">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Simple pricing
          </h2>
          <p className="text-muted-foreground">Bring your own API keys. Pay only for the platform.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {PRICING_TIERS.map(tier => (
            <div
              key={tier.name}
              className={`glass-card rounded-2xl p-6 space-y-5 relative ${tier.highlight ? 'border-primary/40' : ''}`}
            >
              {tier.highlight && (
                <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 text-[10px] bg-primary text-primary-foreground px-3 py-0.5 rounded-full font-bold tracking-wide">
                  MOST POPULAR
                </span>
              )}
              <div>
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-widest mb-2">{tier.name}</p>
                <div className="flex items-baseline gap-1">
                  <span className="font-display text-4xl font-bold text-foreground">${tier.price}</span>
                  <span className="text-muted-foreground text-sm">/ mo</span>
                </div>
              </div>
              <ul className="space-y-2">
                {tier.features.map(f => (
                  <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${tier.highlight ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className={`block text-center text-sm font-semibold rounded-xl py-2.5 transition-opacity ${
                  tier.highlight
                    ? 'bg-primary text-primary-foreground hover:opacity-90'
                    : 'border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors'
                }`}
              >
                Get started
              </Link>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Payments via Bybit Pay · USDT · Instant activation
        </p>
      </div>
    </section>
  )
}

function CtaSection() {
  return (
    <section className="py-24 px-6">
      <div className="max-w-2xl mx-auto text-center">
        <div className="glass-card rounded-3xl p-10 sm:p-14">
          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/15 border border-primary/25 mx-auto mb-6">
            <Zap className="w-7 h-7 text-primary" />
          </div>
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Ready to scale?
          </h2>
          <p className="text-muted-foreground mb-8">
            Sign in and connect your first account in under a minute.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-semibold px-8 py-3 rounded-xl hover:opacity-90 transition-opacity"
          >
            Sign in to XXmachine
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="border-t border-white/8 py-10 px-6">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-6 h-6 rounded-md bg-primary/15 border border-primary/25">
            <Zap className="w-3 h-3 text-primary" />
          </div>
          <span className="text-sm font-semibold text-foreground">XXmachine</span>
        </div>

        <p className="text-xs text-muted-foreground">
          © {new Date().getFullYear()} XXmachine. All rights reserved.
        </p>

        <div className="flex items-center gap-6">
          <Link href="/privacy" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Privacy Policy
          </Link>
          <Link href="/terms" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Terms of Service
          </Link>
        </div>
      </div>
    </footer>
  )
}

// ─── Main export ─────────────────────────────────────────────

export function LandingPage() {
  return (
    <div className="relative min-h-screen">
      <NavBar />
      <main>
        <HeroSection />
        <FeaturesSection />
        <HowItWorksSection />
        <PricingSection />
        <CtaSection />
      </main>
      <Footer />
    </div>
  )
}
