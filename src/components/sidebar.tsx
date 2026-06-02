'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { cn } from '@/lib/utils'
import {
  Zap,
  ImageIcon,
  Users,
  LogOut,
  ChevronRight,
  Layers,
  Clock,
  Film,
  Clapperboard,
  History,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

const NAV_ITEMS = [
  { href: '/bulk', label: 'Generator', icon: ImageIcon },
  { href: '/reels', label: 'Bulk Carousel', icon: Film },
  { href: '/socials', label: 'Connect account', icon: Clapperboard },
  { href: '/motion', label: 'Motion', icon: Clapperboard },
  { href: '/schedule', label: 'Schedule', icon: Clock },
  { href: '/history', label: 'History', icon: History },
]

const ADMIN_ITEMS = [
  { href: '/admin', label: 'Users', icon: Users },
]

interface SidebarProps {
  onMobileClose?: () => void
}

export function Sidebar({ onMobileClose }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { user, logout } = useAuth()

  async function handleLogout() {
    onMobileClose?.()
    await logout()
    router.push('/login')
  }

  return (
    <aside className="flex flex-col w-60 min-h-screen bg-sidebar border-r border-sidebar-border">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-sidebar-border">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/15 border border-primary/25">
          <Zap className="w-4 h-4 text-primary" />
        </div>
        <span className="font-bold text-lg tracking-tight text-foreground">XXmachine</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        <p className="px-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Tools
        </p>
        {NAV_ITEMS.map(item => {
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
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {item.label}
              {active && <ChevronRight className="w-3 h-3 ml-auto text-primary/60" />}
            </Link>
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
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
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

      {/* User */}
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
              {user?.role === 'admin' ? 'Admin' : 'Chatter'}
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