'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import {
  Download, FolderDown, Loader2, Search, AtSign, Eye, Heart, MessageCircle, CheckCircle2, AlertTriangle, History, RefreshCw,
  ChevronLeft, ChevronRight,
} from 'lucide-react'
import type { BulkReelItem } from '@/app/api/instagram/bulk-reels/route'

const PAGE_SIZE = 48

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

interface ScrapedProfile {
  username: string
  last_scanned_at: string
  reels_found: number
}

export function IgDownloaderTab() {
  const [username, setUsername] = useState('')
  const [amount, setAmount] = useState(24)
  const [loading, setLoading] = useState(false)
  const [reels, setReels] = useState<BulkReelItem[]>([])
  const [skipped, setSkipped] = useState<{ permalink: string; reason: string }[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [zipping, setZipping] = useState(false)
  const [history, setHistory] = useState<ScrapedProfile[]>([])
  const [fromCache, setFromCache] = useState(false)
  const [scannedAt, setScannedAt] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/instagram/bulk-reels/history')
      if (res.ok) {
        const data = await res.json()
        setHistory(data.profiles ?? [])
      }
    } catch {}
  }, [])

  useEffect(() => {
    const t = setTimeout(loadHistory, 0)
    return () => clearTimeout(t)
  }, [loadHistory])

  async function fetchReels(force = false, usernameOverride?: string) {
    const clean = (usernameOverride ?? username).trim().replace(/^@/, '')
    if (!clean) { toast.error('Enter an Instagram username'); return }

    setLoading(true)
    setReels([])
    setSkipped([])
    setSelected(new Set())
    try {
      const res = await fetch('/api/instagram/bulk-reels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: clean, amount, force }),
      })
      const data = await res.json()
      setSkipped(data.skipped ?? [])
      if (!res.ok) throw new Error(data.error ?? 'Fetch failed')
      if (!data.reels?.length) { toast.error('No reels found'); return }
      const cleanUsername = data.username ?? clean
      setUsername(cleanUsername)
      setReels(data.reels)
      setPage(0)
      setSelected(new Set(data.reels.map((r: BulkReelItem) => r.id)))
      setFromCache(Boolean(data.fromCache))
      setScannedAt(data.scannedAt ?? null)
      toast.success(data.fromCache
        ? `${data.reels.length} reels for @${cleanUsername} (cached)`
        : `${data.reels.length} reels found for @${cleanUsername}`)
      if (data.skipped?.length) toast.warning(`${data.skipped.length} reels skipped — see the list below`)
      loadHistory()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fetch failed')
    } finally {
      setLoading(false)
    }
  }

  function pickHistoryProfile(u: string) {
    setUsername(u)
    fetchReels(false, u)
  }

  /** Re-resolves a dead/expired video link for one reel via RapidAPI, returns a fresh URL. */
  async function resolveFreshUrl(reel: BulkReelItem): Promise<string> {
    const res = await fetch('/api/instagram/bulk-reels/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permalink: reel.permalink }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Could not refresh link')
    return data.videoUrl as string
  }

  function proxyVideoUrl(url: string): string {
    return `/api/proxy-video?url=${encodeURIComponent(url)}`
  }

  async function fetchVideoBlob(reel: BulkReelItem): Promise<Blob> {
    // Instagram CDN links don't send CORS headers, so a direct browser fetch()
    // is blocked — always go through our own server-side proxy instead.
    try {
      const res = await fetch(proxyVideoUrl(reel.videoUrl))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.blob()
    } catch {
      // Proxy itself failed — the cached link is actually dead (not just CORS), refresh it.
      const freshUrl = await resolveFreshUrl(reel)
      const res = await fetch(proxyVideoUrl(freshUrl))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.blob()
    }
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function downloadOne(reel: BulkReelItem) {
    setDownloadingId(reel.id)
    try {
      const blob = await fetchVideoBlob(reel)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${username.trim().replace(/^@/, '')}_${reel.id}.mp4`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch {
      toast.error('Download failed for that reel')
    } finally {
      setDownloadingId(null)
    }
  }

  async function downloadZip() {
    const targets = reels.filter(r => selected.has(r.id))
    if (!targets.length) { toast.error('Select at least one reel'); return }

    setZipping(true)
    try {
      const JSZipMod = (await import('jszip')).default
      const zip = new JSZipMod()
      let failed = 0
      await Promise.all(targets.map(async (reel, i) => {
        try {
          const blob = await fetchVideoBlob(reel)
          zip.file(`${String(i + 1).padStart(3, '0')}_${reel.id}.mp4`, blob)
        } catch { failed++ }
      }))
      const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(content)
      a.download = `${username.trim().replace(/^@/, '')}_reels_${new Date().toISOString().slice(0, 10)}.zip`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success(failed ? `ZIP downloaded (${failed} failed)` : 'ZIP downloaded')
    } finally {
      setZipping(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Instagram bulk downloader</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1 flex-1 min-w-48">
              <Label className="text-xs text-muted-foreground">Username</Label>
              <div className="relative">
                <AtSign className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') fetchReels() }}
                  placeholder="username"
                  className="h-9 pl-7 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1 w-28">
              <Label className="text-xs text-muted-foreground">Number of reels</Label>
              <Input
                type="number" min={1} max={200} value={amount}
                onChange={e => setAmount(Number(e.target.value))}
                className="h-9 text-sm"
              />
            </div>
            <Button onClick={() => fetchReels()} disabled={loading} className="h-9">
              {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
              Search
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            Lists via Apify, falls back to RapidAPI when Apify is over quota (same as Discovery). Only use for profiles you have the right to download.
            Profiles scanned in the last 12h load instantly from cache instead of re-scanning.
          </p>

        </CardContent>
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
              <History className="w-3.5 h-3.5" />
              Scrape history ({history.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border">
                  <th className="px-4 py-2 font-medium">Username</th>
                  <th className="px-4 py-2 font-medium">Last scanned</th>
                  <th className="px-4 py-2 font-medium">Reels cached</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {history.map(p => (
                  <tr key={p.username} className="border-b border-border last:border-0 hover:bg-secondary/30">
                    <td className="px-4 py-2 font-medium">@{p.username}</td>
                    <td className="px-4 py-2 text-muted-foreground">{formatAge(p.last_scanned_at)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{p.reels_found}</td>
                    <td className="px-4 py-2 text-right">
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={loading}
                        onClick={() => pickHistoryProfile(p.username)}>
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {reels.length > 0 && fromCache && scannedAt && (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-border bg-secondary/30 text-xs">
          <History className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground flex-1">Showing {reels.length} cached reels — scraped {formatAge(scannedAt)}</span>
          <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" disabled={loading} onClick={() => fetchReels(true)}>
            <RefreshCw className="w-2.5 h-2.5" />
            Force rescan
          </Button>
        </div>
      )}

      {reels.length > 0 && (() => {
        const totalPages = Math.ceil(reels.length / PAGE_SIZE)
        const pagedReels = reels.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
        return (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                {selected.size}/{reels.length} selected
                {totalPages > 1 && <span className="normal-case font-normal text-muted-foreground/70"> · page {page + 1}/{totalPages}</span>}
              </CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs"
                  onClick={() => setSelected(prev => new Set([...prev, ...pagedReels.map(r => r.id)]))}>
                  Select page
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs"
                  onClick={() => setSelected(prev => {
                    const next = new Set(prev)
                    pagedReels.forEach(r => next.delete(r.id))
                    return next
                  })}>
                  Deselect page
                </Button>
                <Button size="sm" className="h-7 text-xs" disabled={zipping || selected.size === 0} onClick={downloadZip}>
                  {zipping ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <FolderDown className="w-3 h-3 mr-1.5" />}
                  ZIP ({selected.size})
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              {pagedReels.map(reel => {
                const isSelected = selected.has(reel.id)
                return (
                  <div key={reel.id} className="group relative">
                    <div
                      onClick={() => toggle(reel.id)}
                      className={`aspect-[9/16] rounded-lg overflow-hidden border-2 cursor-pointer transition-all bg-secondary/40 ${isSelected ? 'border-primary' : 'border-transparent opacity-60'}`}
                    >
                      {reel.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/proxy-image?url=${encodeURIComponent(reel.thumbnailUrl)}`}
                          alt=""
                          className="w-full h-full object-cover"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">No preview</div>
                      )}
                      {isSelected && (
                        <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                          <CheckCircle2 className="w-2.5 h-2.5 text-primary-foreground" />
                        </div>
                      )}
                      <div className="absolute bottom-0 inset-x-0 bg-black/70 px-1.5 py-1 flex items-center gap-2 text-[10px] text-white">
                        <span className="flex items-center gap-0.5"><Eye className="w-2.5 h-2.5" />{formatCount(reel.views)}</span>
                        <span className="flex items-center gap-0.5"><Heart className="w-2.5 h-2.5" />{formatCount(reel.likes)}</span>
                        <span className="flex items-center gap-0.5"><MessageCircle className="w-2.5 h-2.5" />{formatCount(reel.comments)}</span>
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); downloadOne(reel) }}
                      disabled={downloadingId === reel.id}
                      className="absolute top-1.5 left-1.5 w-6 h-6 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                      title="Download"
                    >
                      {downloadingId === reel.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                    </button>
                  </div>
                )
              })}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-1 mt-4">
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={page === 0}
                  onClick={() => setPage(p => Math.max(0, p - 1))}>
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                {Array.from({ length: totalPages }, (_, i) => (
                  <Button key={i} size="sm" variant={i === page ? 'default' : 'outline'}
                    className="h-7 w-7 p-0 text-xs" onClick={() => setPage(i)}>
                    {i + 1}
                  </Button>
                ))}
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={page === totalPages - 1}
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        )
      })()}

      {skipped.length > 0 && (
        <Card className="border-yellow-500/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-yellow-500 uppercase tracking-widest flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              {skipped.length} skipped
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {skipped.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <a href={s.permalink} target="_blank" rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground truncate max-w-64 shrink-0">
                    {s.permalink}
                  </a>
                  <span className="text-yellow-500/80 truncate">{s.reason}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
