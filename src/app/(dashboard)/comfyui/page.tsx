'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/** Legacy route — Copy-Paste now lives at /copy-paste. */
export default function ComfyUIRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/copy-paste')
  }, [router])
  return null
}
