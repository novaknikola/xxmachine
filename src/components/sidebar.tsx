'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { cn } from '@/lib/utils'
import {
  Zap,
  ImageIcon,
  Users,
  LogOut,
  ChevronRight,
  ChevronDown,
  Clapperboard,
  History,
  BarChart2,
  Settings,
  Copy,
  Share2,
  RefreshCw,
  Telescope,
  Database,
  Sparkles,
  Layers,
  Captions,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

interface NavItem {
  href: string
  label: string
  icon: typeof ImageIcon
  module?: string
  children?: NavItem[]
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/bulk',
    label: 'Image Studio',
    icon: ImageIcon,
    module: 'generator',
    children: [
      { href: '/bulk?tab=generate', label: 'Image Generate', icon: Sparkles },
      { href: '/bulk?tab=dataset', label: 'Dataset', icon: Database },
      { href: '/bulk?tab=train', label: 'Train LoRA', icon: Layers },
      { href: '/bulk?tab=bulk', label: 'Bulk Generate', icon: ImageIcon },
      { href: '/bulk?tab=carousel', label: 'Carousel', icon: ImageIcon },
    ],
  },
  {
    href: '/captions',
    label: 'Video Studio',
    icon: Clapperboard,
    children: [
      { href: '/captions?tab=captions', label: 'Add Captions', icon: Captions },
      { href: '/repurpose', label: 'Variants', icon: RefreshCw },
    ],
  },
  {
    href: '/socials',
    label: 'Social Media',
    icon: Share2,
    module: 'socials',
    children: [
      { href: '/discovery', label: 'Discovery', icon: Telescope },
      { href: '/discovery?tab=downloader', label: 'IG Downloader', icon: Telescope },
      { href: '/analytics', label: 'Analytics', icon: BarChart2 },
    ],
  },
  { href: '/copy-paste', label: 'Copy-Paste Studio', icon: Copy },
  { href: '/history', label: 'History', icon: History, module: 'history' },
  { href: '/settings', label: 'Settings', icon: Settings },
]

function useIsDesktop() {
  const [desktop, setDesktop] = useState(true)

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const update = () => setDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  return desktop
}

function pathMatches(href: string, pathname: string, search: string) {
  const [path, query] = href.split('?')
  if (!pathname.startsWith(path)) return false
  if (!query) {
    return pathname === path || pathname.startsWith(path + '/')
  }
  const want = new URLSearchParams(query)
  const have = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  for (const [k, v] of want.entries()) {
    if (have.get(k) !== v) return false
  }
  return true
}

function childIsActive(child: NavItem, pathname: string, search: string) {
  return (
    pathMatches(child.href, pathname, search)
    || (child.href.startsWith('/bulk?tab=generate')
      && pathname.startsWith('/bulk')
      && !search.includes('tab='))
  )
}

function groupIsActive(item: NavItem, pathname: string, search: string) {
  if (item.children?.length) {
    return item.children.some(c => childIsActive(c, pathname, search))
  }
  return pathMatches(item.href, pathname, search)
}

const navTriggerClass = (active: boolean) =>
  cn(
    'flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors outline-none',
    active
      ? 'bg-primary/10 text-primary'
      : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
  )

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  onNavigate?: () => void
}) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={navTriggerClass(active)}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="flex-1 text-left">{item.label}</span>
      {active && <ChevronRight className="w-3.5 h-3.5 text-primary/60" />}
    </Link>
  )
}

function NavFlyout({
  item,
  items,
  pathname,
  search,
  onNavigate,
}: {
  item: NavItem
  items: NavItem[]
  pathname: string
  search: string
  onNavigate?: () => void
}) {
  const Icon = item.icon
  const active = groupIsActive(item, pathname, search)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => { setMounted(true) }, [])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const place = () => {
      const rect = triggerRef.current!.getBoundingClientRect()
      const panelW = 256
      const gap = 12
      let left = rect.right + gap
      let top = rect.top
      if (left + panelW > window.innerWidth - 8) {
        left = Math.max(8, rect.left - panelW - gap)
      }
      const approxH = 56 + items.length * 44
      if (top + approxH > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - approxH - 8)
      }
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, items.length])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(v => !v)}
        className={navTriggerClass(active || open)}
      >
        <Icon className="w-4 h-4 shrink-0" />
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronRight className={cn('w-4 h-4 shrink-0 opacity-50 transition-transform', open && 'translate-x-0.5')} />
      </button>
      {mounted && open && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label={item.label}
          style={{ top: pos.top, left: pos.left }}
          className={cn(
            'fixed z-[100] w-64 p-2 rounded-xl shadow-lg',
            'bg-popover/95 backdrop-blur-md ring-1 ring-border/60 text-popover-foreground',
          )}
        >
          <p className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {item.label}
          </p>
          <div className="flex flex-col gap-0.5">
            {items.map(child => {
              const ChildIcon = child.icon
              const isActive = childIsActive(child, pathname, search)
              return (
                <Link
                  key={child.href}
                  href={child.href}
                  role="menuitem"
                  onClick={() => {
                    setOpen(false)
                    onNavigate?.()
                  }}
                  className={cn(
                    'flex items-center min-h-10 gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
                  )}
                >
                  <ChildIcon className="w-4 h-4 opacity-80 shrink-0" />
                  <span className="flex-1">{child.label}</span>
                  {isActive && <ChevronRight className="w-3.5 h-3.5 opacity-60" />}
                </Link>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/** Mobile: expand in-place — flyout has no room beside a drawer. */
function NavAccordion({
  item,
  items,
  pathname,
  search,
  onNavigate,
}: {
  item: NavItem
  items: NavItem[]
  pathname: string
  search: string
  onNavigate?: () => void
}) {
  const active = groupIsActive(item, pathname, search)
  const [open, setOpen] = useState(active)
  const Icon = item.icon

  useEffect(() => {
    if (active) setOpen(true)
  }, [active])

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={navTriggerClass(active)}
        aria-expanded={open}
      >
        <Icon className="w-4 h-4 shrink-0" />
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronDown
          className={cn(
            'w-4 h-4 shrink-0 opacity-50 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div className="ml-2 pl-3 border-l border-sidebar-border space-y-0.5">
          {items.map(child => {
            const ChildIcon = child.icon
            const isActive = childIsActive(child, pathname, search)
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors min-h-10',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
                )}
              >
                <ChildIcon className="w-4 h-4 shrink-0 opacity-80" />
                <span className="flex-1">{child.label}</span>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function NavGroup(props: {
  item: NavItem
  items: NavItem[]
  pathname: string
  search: string
  onNavigate?: () => void
  desktop: boolean
}) {
  if (props.desktop) return <NavFlyout {...props} />
  return <NavAccordion {...props} />
}

const ADMIN_ITEMS = [
  { href: '/admin', label: 'Users', icon: Users },
]

interface SidebarProps {
  onMobileClose?: () => void
}

export function Sidebar({ onMobileClose }: SidebarProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams?.toString() ? `?${searchParams.toString()}` : ''
  const router = useRouter()
  const { user, logout } = useAuth()
  const [permissions, setPermissions] = useState<Record<string, boolean>>({})
  const desktop = useIsDesktop()

  useEffect(() => {
    if (!user || user.role === 'admin') return

    fetch(`/api/admin/permissions?userId=${user.id}`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        const map: Record<string, boolean> = {}
        for (const p of data?.permissions ?? []) {
          map[p.module_name] = p.enabled
        }
        setPermissions(map)
      })
      .catch(() => {})
  }, [user])

  function allowed(item: NavItem) {
    return user?.role === 'admin' || !item.module || permissions[item.module] !== false
  }

  async function handleLogout() {
    onMobileClose?.()
    await logout()
    router.push('/login')
  }

  return (
    <aside className="flex flex-col w-64 h-full min-h-0 md:min-h-screen bg-sidebar border-r border-sidebar-border">
      <div className="shrink-0 border-b border-sidebar-border">
        <Link
          href="/"
          onClick={onMobileClose}
          className="flex items-center gap-3 px-5 py-5 hover:bg-secondary/40 transition-colors"
        >
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/15 border border-primary/25">
            <Zap className="w-4 h-4 text-primary" />
          </div>
          <span className="font-bold text-lg tracking-tight text-foreground">XXmachine</span>
        </Link>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-5 space-y-1.5">
        <p className="px-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Tools
        </p>
        {NAV_ITEMS.filter(allowed).map(item => {
          const children = item.children?.filter(allowed) ?? []
          if (children.length > 0) {
            return (
              <NavGroup
                key={item.href}
                item={item}
                items={children}
                pathname={pathname}
                search={search}
                onNavigate={onMobileClose}
                desktop={desktop}
              />
            )
          }
          return (
            <NavLink
              key={item.href}
              item={item}
              active={pathMatches(item.href, pathname, search)}
              onNavigate={onMobileClose}
            />
          )
        })}

        {user?.role === 'admin' && (
          <>
            <Separator className="my-4 bg-sidebar-border" />
            <p className="px-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              Admin
            </p>
            {ADMIN_ITEMS.map(item => {
              const Icon = item.icon
              const active = pathname.startsWith(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onMobileClose}
                  className={navTriggerClass(active)}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{item.label}</span>
                  {active && <ChevronRight className="w-3.5 h-3.5 text-primary/60" />}
                </Link>
              )
            })}
          </>
        )}
      </nav>

      <div className="shrink-0 px-3 py-4 border-t border-sidebar-border pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-3 px-2.5 py-2.5 rounded-xl">
          <Avatar className="w-9 h-9 shrink-0">
            <AvatarFallback className="bg-primary/15 text-primary text-xs font-bold">
              {user?.display_name?.slice(0, 2).toUpperCase() ?? 'U'}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{user?.display_name}</p>
            <Badge
              variant="secondary"
              className="text-[11px] px-1.5 py-0 h-5 mt-1 font-normal"
            >
              {user?.role === 'admin' ? 'Admin' : 'User'}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive shrink-0"
            onClick={handleLogout}
            title="Logout"
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </aside>
  )
}
