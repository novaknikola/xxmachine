'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, RefreshCw } from 'lucide-react'

/**
 * Without this file Next renders its own "This page couldn't load" screen,
 * which shows nothing about what actually failed — a client-side crash left no
 * trace in the server logs and no message on screen, so there was nothing to
 * act on. This keeps the recovery buttons and adds the error itself.
 *
 * `digest` is the only handle on a minified production stack; it matches an
 * entry in the server log when the error came from a server component.
 */
export default function DashboardError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  // Named `reset` in older Next; this version passes `unstable_retry`, and the
  // old name arrives undefined — see node_modules/next/dist/docs error.md.
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error('[dashboard] render error:', error)
  }, [error])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10">
        <AlertTriangle className="h-5 w-5 text-destructive" />
      </div>

      <div className="space-y-1">
        <h2 className="text-base font-semibold">This page hit an error</h2>
        <p className="max-w-xl text-xs text-muted-foreground">
          {error.message || 'No message was attached to the error.'}
        </p>
        {error.digest && (
          <p className="font-mono text-[10px] text-muted-foreground/60">digest: {error.digest}</p>
        )}
      </div>

      {error.stack && (
        <details className="w-full max-w-2xl text-left">
          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
            Stack trace
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-secondary/50 p-3 text-[10px] leading-relaxed whitespace-pre-wrap break-words">
            {error.stack}
          </pre>
        </details>
      )}

      <div className="flex gap-2">
        <Button onClick={() => unstable_retry()} size="sm">
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Try again
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Hard reload
        </Button>
      </div>

      <p className="max-w-md text-[10px] text-muted-foreground/60">
        A stale build is the common cause right after a deploy: the tab asks for
        JS chunks the new build replaced. Hard reload fixes that one.
      </p>
    </div>
  )
}
