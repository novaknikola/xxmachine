'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { Sidebar } from '@/components/sidebar'
import { Loader2, Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

const ROUTE_MODULES: Record<string, string> = {
  '/bulk': 'generator',
  '/reels': 'reels',
  '/socials': 'socials',
  '/motion': 'motion',
  '/copy-paste': 'generator',
  '/schedule': 'schedule',
  '/history': 'history',
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [permissionLoading, setPermissionLoading] = useState(false)
  const [allowed, setAllowed] = useState(true)

  const moduleName = useMemo(() => {
    const match = Object.keys(ROUTE_MODULES)
      .sort((a, b) => b.length - a.length)
      .find(route => pathname.startsWith(route))

    return match ? ROUTE_MODULES[match] : null
  }, [pathname])

  useEffect(() => {
    if (!loading && !user) router.push('/login')
  }, [user, loading, router])

  useEffect(() => {
    let cancelled = false

    async function checkPermission() {
      if (!user || user.role === 'admin' || !moduleName) {
        setAllowed(true)
        return
      }

      setPermissionLoading(true)

      try {
        const res = await fetch(`/api/admin/permissions?userId=${user.id}`)

        if (!res.ok) {
          if (!cancelled) setAllowed(false)
          return
        }

        const data = await res.json()
        const found = (data.permissions ?? []).find(
          (p: { module_name: string; enabled: boolean }) => p.module_name === moduleName
        )

        if (!cancelled) {
          setAllowed(found?.enabled !== false)
        }
      } catch {
        if (!cancelled) setAllowed(false)
      } finally {
        if (!cancelled) setPermissionLoading(false)
      }
    }

    checkPermission()

    return () => {
      cancelled = true
    }
  }, [user, moduleName])

  useEffect(() => {
    if (!loading && user && !permissionLoading && !allowed) {
      router.push('/generate')
    }
  }, [loading, user, permissionLoading, allowed, router])

  // Close mobile drawer after navigation (back/forward or link).
  useEffect(() => {
    setSidebarOpen(false)
  }, [pathname])

  if (loading || permissionLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    )
  }

  if (!user || !allowed) return null

  return (
    <div className="flex h-dvh overflow-hidden flex-col md:flex-row">
      <header className="md:hidden shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-border/60 bg-sidebar/80 backdrop-blur-xl pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          href="/"
          className="font-display text-lg font-bold text-primary tracking-tight"
          onClick={() => setSidebarOpen(false)}
        >
          XXmachine
        </Link>
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          onClick={() => setSidebarOpen(open => !open)}
          aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={sidebarOpen}
        >
          {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </Button>
      </header>

      <>
        {sidebarOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/50 z-40 backdrop-blur-[1px]"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
        )}
        <div
          className={`${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          } md:translate-x-0 fixed md:static top-0 left-0 z-50 md:z-auto w-64 h-dvh md:h-auto md:w-auto transition-transform duration-300 ease-out shadow-xl md:shadow-none`}
        >
          <Suspense fallback={null}>
            <Sidebar onMobileClose={() => setSidebarOpen(false)} />
          </Suspense>
        </div>
      </>

      <main className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain bg-background w-full">
        {children}
      </main>
    </div>
  )
}