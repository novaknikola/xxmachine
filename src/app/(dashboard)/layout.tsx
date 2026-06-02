'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { Sidebar } from '@/components/sidebar'
import { Loader2, Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    if (!loading && !user) router.push('/login')
  }, [user, loading, router])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    )
  }

  if (!user) return null

  return (
    <div className="flex h-screen overflow-hidden flex-col md:flex-row">
      {/* Mobile Header */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 border-b border-white/10 bg-sidebar/60 backdrop-blur-xl">
        <h1 className="font-display text-lg font-bold text-primary tracking-tight">XXmachine</h1>
        <Button
          variant="ghost"
          size="icon"
          className="w-9 h-9"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </Button>
      </div>

      {/* Sidebar - Mobile overlay + Desktop sidebar */}
      <>
        {sidebarOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/50 z-40"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div
          className={`${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          } md:translate-x-0 fixed md:static md:w-auto w-60 h-screen md:h-auto transition-transform duration-300 ease-out z-50 md:z-auto`}
        >
          <Sidebar onMobileClose={() => setSidebarOpen(false)} />
        </div>
      </>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto bg-background w-full">
        {children}
      </main>
    </div>
  )
}
