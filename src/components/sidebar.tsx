'use client'
import { useEffect, useState } from 'react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

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
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
      )}
    >
      <Icon className="w-4 h-4 shrink-0" />
      {item.label}
      {active && <ChevronRight className="w-3 h-3 ml-auto text-primary/60" />}
    </Link>
  )
}

function NavDropdown({
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
  const router = useRouter()
  const Icon = item.icon
  const active = groupIsActive(item, pathname, search)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors outline-none',
          active
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
        )}
      >
        <Icon className="w-4 h-4 shrink-0" />
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" sideOffset={8} className="min-w-48">
        {items.map(child => {
          const ChildIcon = child.icon
          const isActive = childIsActive(child, pathname, search)
          return (
            <DropdownMenuItem
              key={child.href}
              className={cn(
                'gap-2 cursor-pointer',
                isActive && 'bg-accent text-accent-foreground',
              )}
              onClick={() => {
                router.push(child.href)
                onNavigate?.()
              }}
            >
              <ChildIcon className="w-4 h-4" />
              {child.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
    <aside className="flex flex-col w-60 min-h-screen bg-sidebar border-r border-sidebar-border">
      <div className="flex items-center gap-3 px-5 py-5 border-b border-sidebar-border">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/15 border border-primary/25">
          <Zap className="w-4 h-4 text-primary" />
        </div>
        <span className="font-bold text-lg tracking-tight text-foreground">XXmachine</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        <p className="px-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Tools
        </p>
        {NAV_ITEMS.filter(allowed).map(item => {
          const children = item.children?.filter(allowed) ?? []
          if (children.length > 0) {
            return (
              <NavDropdown
                key={item.href}
                item={item}
                items={children}
                pathname={pathname}
                search={search}
                onNavigate={onMobileClose}
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
            <Separator className="my-3 bg-sidebar-border" />
            <p className="px-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
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
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
                  )}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {item.label}
                  {active && <ChevronRight className="w-3 h-3 ml-auto text-primary/60" />}
                </Link>
              )
            })}
          </>
        )}
      </nav>

      <div className="px-3 py-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3 px-2 py-2 rounded-lg">
          <Avatar className="w-8 h-8 shrink-0">
            <AvatarFallback className="bg-primary/15 text-primary text-xs font-bold">
              {user?.display_name?.slice(0, 2).toUpperCase() ?? 'U'}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{user?.display_name}</p>
            <Badge
              variant="secondary"
              className="text-xs px-1.5 py-0 h-4 mt-0.5 font-normal"
            >
              {user?.role === 'admin' ? 'Admin' : 'User'}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="w-7 h-7 text-muted-foreground hover:text-destructive shrink-0"
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
