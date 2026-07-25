'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import {
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Plus,
  Trash2,
  Loader2,
  Clock,
  AlertCircle,
  Users,
  Eye,
} from 'lucide-react'

// ─── Types ──────────────────────────────────────────────────────

interface StatSnapshot {
  id: string
  platform: 'instagram' | 'threads' | 'twitter' | 'tiktok'
  account_id: string
  account_name: string
  followers: number | null
  following: number | null
  posts_count: number | null
  views_30d: number | null
  reach_30d: number | null
  impressions_30d: number | null
  likes_total: number | null
  fetched_at: string
  has_error: boolean
}

interface SummaryData {
  stats: {
    instagram: StatSnapshot[]
    threads: StatSnapshot[]
    twitter: StatSnapshot[]
    tiktok: StatSnapshot[]
  }
  totals: {
    totalAccounts: number
    totalFollowers: number
    totalViews30d: number
    lastFetchedAt: string | null
  }
}

interface SocialAccount {
  id: string
  platform: 'twitter' | 'tiktok'
  username: string
  display_name: string | null
  avatar_url: string | null
}

interface AccountTrend {
  account_id: string
  account_name: string
  platform: string
  data: { day: string; followers: number | null; views_30d: number | null }[]
}

interface TrendsData {
  byAccount: AccountTrend[]
  totals: { day: string; followers: number; views_30d: number }[]
}

// ─── Constants ──────────────────────────────────────────────────

const PLATFORM_META: Record<string, { label: string; color: string; textColor: string; chartColor: string }> = {
  instagram: { label: 'Instagram', color: 'bg-pink-500/15', textColor: 'text-pink-400', chartColor: '#f472b6' },
  threads:   { label: 'Threads',   color: 'bg-zinc-500/15', textColor: 'text-zinc-300',  chartColor: '#a1a1aa' },
  twitter:   { label: 'X / Twitter', color: 'bg-sky-500/15', textColor: 'text-sky-400', chartColor: '#38bdf8' },
  tiktok:    { label: 'TikTok',    color: 'bg-rose-500/15', textColor: 'text-rose-400',  chartColor: '#fb7185' },
}

const ACCOUNT_COLORS = [
  '#818cf8', '#34d399', '#f472b6', '#38bdf8', '#fb923c',
  '#a78bfa', '#4ade80', '#e879f9', '#22d3ee', '#fbbf24',
]

// ─── Helpers ────────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

function fmtShort(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K'
  return n.toLocaleString()
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never'
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3_600_000)
  if (h < 1) return 'Just now'
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmtDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function deltaPercent(current: number, previous: number): number | null {
  if (!previous) return null
  return Math.round(((current - previous) / previous) * 100)
}

// ─── Components ─────────────────────────────────────────────────

function PlatformBadge({ platform }: { platform: string }) {
  const m = PLATFORM_META[platform] ?? { label: platform, color: 'bg-secondary', textColor: 'text-foreground' }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${m.color} ${m.textColor}`}>
      {m.label}
    </span>
  )
}

function StatusBadge({ snapshot }: { snapshot: StatSnapshot }) {
  const staleMs = Date.now() - new Date(snapshot.fetched_at).getTime()
  const isStale = staleMs > 48 * 3_600_000
  if (snapshot.has_error) return (
    <span className="flex items-center gap-1 text-xs text-red-400">
      <AlertCircle className="w-3 h-3" /> Error
    </span>
  )
  if (isStale) return (
    <span className="flex items-center gap-1 text-xs text-yellow-400">
      <Clock className="w-3 h-3" /> Stale
    </span>
  )
  return <span className="text-xs text-emerald-400">OK</span>
}

function StatCard({
  label, value, sub, delta, icon,
}: {
  label: string
  value: string
  sub?: string
  delta?: number | null
  icon?: React.ReactNode
}) {
  return (
    <div className="bg-card border border-border rounded-xl px-5 py-4 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
        {icon && <span className="text-muted-foreground/50">{icon}</span>}
      </div>
      <p className="text-2xl font-bold text-foreground">{value}</p>
      <div className="flex items-center gap-2 min-h-[18px]">
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        {delta != null && (
          <span className={`flex items-center gap-0.5 text-xs font-medium ${delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {delta >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {delta >= 0 ? '+' : ''}{delta}%
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Add Account Modal ──────────────────────────────────────────

function AddAccountModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [platform, setPlatform] = useState<'twitter' | 'tiktok'>('twitter')
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim()) return
    setLoading(true)
    try {
      const res = await fetch('/api/analytics/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, username: username.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(`@${username.replace(/^@/, '')} added`)
      setUsername('')
      onAdded()
      onClose()
    } catch (err) {
      toast.error(String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add account</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="flex gap-2">
            {(['twitter', 'tiktok'] as const).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => setPlatform(p)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  platform === p
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {p === 'twitter' ? 'X / Twitter' : 'TikTok'}
              </button>
            ))}
          </div>
          <Input
            placeholder="@username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoFocus
          />
          <Button type="submit" className="w-full" disabled={loading || !username.trim()}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
            Add account
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Account Drill-down Modal ───────────────────────────────────

function AccountModal({
  snapshot,
  onClose,
}: {
  snapshot: StatSnapshot | null
  onClose: () => void
}) {
  const [trendData, setTrendData] = useState<{ day: string; followers: number | null; views_30d: number | null }[]>([])
  const [loading, setLoading] = useState(false)
  const [days, setDays] = useState(30)

  useEffect(() => {
    if (!snapshot) return
    setLoading(true)
    fetch(`/api/analytics/trends?account_id=${snapshot.account_id}&platform=${snapshot.platform}&days=${days}`)
      .then(r => r.json())
      .then(d => setTrendData(Array.isArray(d) ? d : []))
      .catch(() => setTrendData([]))
      .finally(() => setLoading(false))
  }, [snapshot, days])

  if (!snapshot) return null

  const m = PLATFORM_META[snapshot.platform]
  const chartData = trendData.map(d => ({
    day: fmtDay(d.day),
    Followers: d.followers,
    Views: d.views_30d,
  }))

  return (
    <Dialog open={!!snapshot} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlatformBadge platform={snapshot.platform} />
            @{snapshot.account_name}
          </DialogTitle>
        </DialogHeader>

        {/* Current stats row */}
        <div className="grid grid-cols-4 gap-3 text-center py-2">
          {[
            { label: 'Followers', value: fmt(snapshot.followers) },
            { label: 'Posts', value: fmt(snapshot.posts_count) },
            { label: 'Views 30d', value: fmt(snapshot.views_30d) },
            { label: 'Likes', value: fmt(snapshot.likes_total) },
          ].map(({ label, value }) => (
            <div key={label} className="bg-secondary/40 rounded-lg py-2">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-lg font-bold">{value}</p>
            </div>
          ))}
        </div>

        {/* Range tabs */}
        <div className="flex gap-1">
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                days === d ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>

        {/* Chart */}
        <div className="h-52">
          {loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : chartData.length < 2 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Not enough data for this range
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#71717a' }} />
                <YAxis tick={{ fontSize: 10, fill: '#71717a' }} tickFormatter={fmtShort} width={48} />
                <Tooltip
                  contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number) => fmt(v)}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="Followers" stroke={m?.chartColor ?? '#818cf8'} dot={false} strokeWidth={2} />
                {trendData.some(d => d.views_30d != null) && (
                  <Line type="monotone" dataKey="Views" stroke="#94a3b8" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />
                )}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Growth Chart Section ────────────────────────────────────────

function GrowthChart({ trendsData, loading }: { trendsData: TrendsData | null; loading: boolean }) {
  const [metric, setMetric] = useState<'followers' | 'views_30d'>('followers')
  const [mode, setMode] = useState<'total' | 'individual'>('total')

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-5 h-64 flex items-center justify-center text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading chart…
      </div>
    )
  }

  if (!trendsData || trendsData.totals.length < 2) {
    return (
      <div className="bg-card border border-border rounded-xl p-5 h-64 flex flex-col items-center justify-center text-muted-foreground gap-2">
        <TrendingUp className="w-8 h-8 opacity-20" />
        <p className="text-sm">No historical data yet — check back after a few syncs</p>
      </div>
    )
  }

  // Build recharts data
  let chartData: Record<string, unknown>[]

  if (mode === 'total') {
    chartData = trendsData.totals.map(d => ({
      day: fmtDay(d.day),
      Total: metric === 'followers' ? d.followers : d.views_30d,
    }))
  } else {
    // All days from totals as baseline
    const days = trendsData.totals.map(d => d.day)
    chartData = days.map(day => {
      const row: Record<string, unknown> = { day: fmtDay(day) }
      trendsData.byAccount.forEach(acct => {
        const point = acct.data.find(p => p.day === day)
        if (point) row[`${acct.platform}:${acct.account_name}`] = metric === 'followers' ? point.followers : point.views_30d
      })
      return row
    })
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-sm font-semibold text-foreground">
          {metric === 'followers' ? 'Followers growth' : 'Views (30d) trend'}
        </h2>
        <div className="flex items-center gap-2">
          {/* Metric toggle */}
          <div className="flex rounded-lg border border-border overflow-hidden text-xs">
            {(['followers', 'views_30d'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`px-3 py-1.5 transition-colors ${
                  metric === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'followers' ? 'Followers' : 'Views'}
              </button>
            ))}
          </div>
          {/* Mode toggle */}
          <div className="flex rounded-lg border border-border overflow-hidden text-xs">
            {(['total', 'individual'] as const).map(v => (
              <button
                key={v}
                onClick={() => setMode(v)}
                className={`px-3 py-1.5 transition-colors ${
                  mode === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {v === 'total' ? 'Total' : 'Per account'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#71717a' }} />
            <YAxis tick={{ fontSize: 10, fill: '#71717a' }} tickFormatter={fmtShort} width={48} />
            <Tooltip
              contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8, fontSize: 12 }}
              formatter={(v: number) => fmt(v)}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {mode === 'total' ? (
              <Line type="monotone" dataKey="Total" stroke="#818cf8" dot={false} strokeWidth={2.5} />
            ) : (
              trendsData.byAccount.map((acct, i) => (
                <Line
                  key={`${acct.platform}:${acct.account_id}`}
                  type="monotone"
                  dataKey={`${acct.platform}:${acct.account_name}`}
                  name={`@${acct.account_name}`}
                  stroke={ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]}
                  dot={false}
                  strokeWidth={1.5}
                />
              ))
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────

type PlatformFilter = 'all' | 'instagram' | 'threads' | 'twitter' | 'tiktok'

export default function AnalyticsPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [trendsData, setTrendsData] = useState<TrendsData | null>(null)
  const [socialAccounts, setSocialAccounts] = useState<SocialAccount[]>([])
  const [filter, setFilter] = useState<PlatformFilter>('all')
  const [trendDays, setTrendDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [trendsLoading, setTrendsLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [drillSnapshot, setDrillSnapshot] = useState<StatSnapshot | null>(null)

  const loadSummary = useCallback(async () => {
    try {
      const [sumRes, accRes] = await Promise.all([
        fetch('/api/analytics/summary'),
        fetch('/api/analytics/accounts'),
      ])
      if (sumRes.ok) setSummary(await sumRes.json())
      if (accRes.ok) setSocialAccounts(await accRes.json())
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTrends = useCallback(async (days: number) => {
    setTrendsLoading(true)
    try {
      const res = await fetch(`/api/analytics/group-trends?days=${days}`)
      if (res.ok) setTrendsData(await res.json())
    } catch {
      // ignore
    } finally {
      setTrendsLoading(false)
    }
  }, [])

  useEffect(() => { loadSummary() }, [loadSummary])
  useEffect(() => { loadTrends(trendDays) }, [loadTrends, trendDays])

  async function handleRefresh() {
    if (!isAdmin) return
    setRefreshing(true)
    try {
      const res = await fetch('/api/analytics/refresh', { method: 'POST' })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Stats refreshed')
      await loadSummary()
      await loadTrends(trendDays)
    } catch (err) {
      toast.error(String(err))
    } finally {
      setRefreshing(false)
    }
  }

  async function handleDeleteAccount(id: string, username: string) {
    if (!confirm(`Remove @${username}?`)) return
    try {
      const res = await fetch('/api/analytics/accounts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Account removed')
      await loadSummary()
    } catch (err) {
      toast.error(String(err))
    }
  }

  const allStats: StatSnapshot[] = summary
    ? [
        ...summary.stats.instagram,
        ...summary.stats.threads,
        ...summary.stats.twitter,
        ...summary.stats.tiktok,
      ]
    : []

  const filtered = filter === 'all' ? allStats : allStats.filter(s => s.platform === filter)
  const totals = summary?.totals

  // Delta: compare first vs last point in totals trend
  const trendTotals = trendsData?.totals ?? []
  const followersDelta = trendTotals.length >= 2
    ? deltaPercent(trendTotals[trendTotals.length - 1].followers, trendTotals[0].followers)
    : null
  const viewsDelta = trendTotals.length >= 2
    ? deltaPercent(trendTotals[trendTotals.length - 1].views_30d, trendTotals[0].views_30d)
    : null

  const FILTERS: { key: PlatformFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'threads', label: 'Threads' },
    { key: 'twitter', label: 'X / Twitter' },
    { key: 'tiktok', label: 'TikTok' },
  ]

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 sm:px-6 pt-6 pb-4 shrink-0">
        <div>
          <h1 className="text-xl font-bold text-foreground">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-0.5">All accounts across platforms</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Trend range selector */}
          <div className="flex rounded-lg border border-border overflow-hidden text-xs">
            {[7, 30, 90].map(d => (
              <button
                key={d}
                onClick={() => setTrendDays(d)}
                className={`px-3 py-1.5 transition-colors ${
                  trendDays === d ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          {isAdmin && (
            <>
              <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="w-4 h-4 mr-1.5" />
                Add account
              </Button>
              <Button size="sm" onClick={handleRefresh} disabled={refreshing}>
                {refreshing
                  ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                  : <RefreshCw className="w-4 h-4 mr-1.5" />}
                Refresh
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 px-4 sm:px-6 pb-5 shrink-0">
        <StatCard
          label="Total accounts"
          value={loading ? '…' : String(totals?.totalAccounts ?? 0)}
          icon={<Users className="w-4 h-4" />}
        />
        <StatCard
          label="Total followers"
          value={loading ? '…' : fmt(totals?.totalFollowers ?? 0)}
          sub={`${trendDays}d range`}
          delta={followersDelta}
          icon={<TrendingUp className="w-4 h-4" />}
        />
        <StatCard
          label="Views (30d)"
          value={loading ? '…' : fmt(totals?.totalViews30d ?? 0)}
          sub="Instagram + Threads"
          delta={viewsDelta}
          icon={<Eye className="w-4 h-4" />}
        />
        <StatCard
          label="Last refreshed"
          value={loading ? '…' : timeAgo(totals?.lastFetchedAt ?? null)}
          icon={<Clock className="w-4 h-4" />}
        />
      </div>

      {/* Growth chart */}
      <div className="px-4 sm:px-6 pb-5 shrink-0">
        <GrowthChart trendsData={trendsData} loading={trendsLoading} />
      </div>

      {/* Platform filter tabs */}
      <div className="overflow-x-auto shrink-0 border-b border-border">
        <div className="flex items-center gap-1 px-4 sm:px-6 min-w-max">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
                filter === f.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
              {f.key !== 'all' && summary && (
                <span className="ml-1.5 text-xs opacity-60">
                  {summary.stats[f.key]?.length ?? 0}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
            <TrendingUp className="w-8 h-8 opacity-30" />
            <p className="text-sm">No stats yet — connect accounts and click Refresh</p>
            {isAdmin && (
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setAddOpen(true)}>
                <Plus className="w-4 h-4 mr-1.5" />
                Add Twitter / TikTok account
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="pb-2 font-medium pr-4 pl-4 sm:pl-0">Account</th>
                  <th className="pb-2 font-medium pr-4">Platform</th>
                  <th className="pb-2 font-medium pr-4 text-right">Followers</th>
                  <th className="pb-2 font-medium pr-4 text-right">Posts</th>
                  <th className="pb-2 font-medium pr-4 text-right">Views 30d</th>
                  <th className="pb-2 font-medium pr-4 text-right">Likes</th>
                  <th className="pb-2 font-medium pr-4">Updated</th>
                  <th className="pb-2 font-medium">Status</th>
                  {isAdmin && <th className="pb-2 pr-4" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {filtered.map(s => {
                  const sa = socialAccounts.find(a => a.id === s.account_id)
                  return (
                    <tr
                      key={`${s.platform}-${s.account_id}`}
                      className="hover:bg-secondary/30 transition-colors cursor-pointer"
                      onClick={() => setDrillSnapshot(s)}
                    >
                      <td className="py-3 pr-4 font-medium pl-4 sm:pl-0">@{s.account_name}</td>
                      <td className="py-3 pr-4"><PlatformBadge platform={s.platform} /></td>
                      <td className="py-3 pr-4 text-right tabular-nums">{fmt(s.followers)}</td>
                      <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">{fmt(s.posts_count)}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">{fmt(s.views_30d)}</td>
                      <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">{fmt(s.likes_total)}</td>
                      <td className="py-3 pr-4 text-xs text-muted-foreground">{timeAgo(s.fetched_at)}</td>
                      <td className="py-3 pr-4"><StatusBadge snapshot={s} /></td>
                      {isAdmin && (
                        <td className="py-3" onClick={e => e.stopPropagation()}>
                          {sa && (
                            <button
                              onClick={() => handleDeleteAccount(sa.id, sa.username)}
                              className="text-muted-foreground hover:text-destructive transition-colors"
                              title="Remove account"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AddAccountModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={loadSummary} />
      <AccountModal snapshot={drillSnapshot} onClose={() => setDrillSnapshot(null)} />
    </div>
  )
}
