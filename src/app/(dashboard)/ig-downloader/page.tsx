'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// The downloader now lives as a tab inside Discovery — keep this route so old
// links and bookmarks still land in the right place.
export default function IgDownloaderRedirectPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/discovery?tab=downloader')
  }, [router])

  return null
}
