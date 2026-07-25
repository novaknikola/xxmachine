'use client'

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

export interface SessionUser {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'user'
  subscription_status?: string
}

export interface LoginResult {
  ok: boolean
  requires2fa?: boolean
  userId?: string
  error?: string
}

interface AuthContextValue {
  user: SessionUser | null
  loading: boolean
  needsBootstrap: boolean
  login: (email: string, password: string) => Promise<LoginResult>
  verify2fa: (userId: string, code: string, endpoint?: string) => Promise<boolean>
  logout: () => Promise<void>
  setUser: (user: SessionUser | null) => void
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

  const login = useCallback(async (email: string, password: string): Promise<LoginResult> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) return { ok: false, error: data.error }
      if (data.requires2fa) return { ok: false, requires2fa: true, userId: data.userId }
      if (data.user) setUser(data.user)
      return { ok: true }
    } catch {
      return { ok: false, error: 'network_error' }
    }
  }, [])

  const verify2fa = useCallback(async (
    userId: string,
    code: string,
    endpoint = '/api/auth/login/verify',
  ): Promise<boolean> => {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, code }),
      })
      const data = await res.json()
      if (!res.ok) return false
      if (data.user) setUser(data.user)
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
      setUser(null)
    }
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, needsBootstrap, login, verify2fa, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
