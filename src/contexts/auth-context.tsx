'use client'

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

export interface SessionUser {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'chatter'
}

interface AuthContextValue {
  user: SessionUser | null
  loading: boolean
  needsBootstrap: boolean
  login: (email: string, password: string) => Promise<boolean>
  bootstrap: (email: string, password: string, name: string) => Promise<boolean>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [needsBootstrap, setNeedsBootstrap] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    async function init() {
      try {
        const [meRes, bsRes] = await Promise.all([
          fetch('/api/auth/me', { signal: controller.signal }),
          fetch('/api/auth/bootstrap-status', { signal: controller.signal }),
        ])
        const me = await meRes.json()
        const bs = await bsRes.json()
        if (me.user) setUser(me.user)
        setNeedsBootstrap(bs.needsBootstrap ?? false)
      } catch {
        // timeout or network error — show login form anyway
      } finally {
        clearTimeout(timeout)
        setLoading(false)
      }
    }
    init()
    return () => controller.abort()
  }, [])

  const login = useCallback(async (email: string, password: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) return false
      const data = await res.json()
      if (data.user) setUser(data.user)
      return true
    } catch {
      return false
    }
  }, [])

  const bootstrap = useCallback(async (email: string, password: string, name: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, display_name: name }),
      })
      if (!res.ok) return false
      const data = await res.json()
      if (data.user) {
        setUser(data.user)
        setNeedsBootstrap(false)
      }
      return true
    } catch {
      return false
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' })
      if (res.ok) setUser(null)
    } catch {
      // network failure — clear local state anyway so the user isn't stuck
      setUser(null)
    }
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, needsBootstrap, login, bootstrap, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
