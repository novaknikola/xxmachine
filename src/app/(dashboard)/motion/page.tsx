'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function MotionRedirectPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/copy-paste')
  }, [router])
  return null
}
