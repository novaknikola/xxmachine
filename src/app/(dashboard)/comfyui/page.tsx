/** Legacy /comfyui → My Pod hub. */
'use client'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function RedirectInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  useEffect(() => {
    const tab = searchParams.get('tab')
    const mapped = tab === 'queue' || tab === 'templates' || tab === 'generate'
      ? tab
      : 'connection'
    router.replace(`/my-pod?tab=${mapped}`)
  }, [router, searchParams])
  return null
}

export default function ComfyUIRedirect() {
  return (
    <Suspense fallback={null}>
      <RedirectInner />
    </Suspense>
  )
}
