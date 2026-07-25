'use client'

import { Download } from 'lucide-react'
import { IgDownloaderTab } from './ig-downloader-tab'

export default function IgDownloaderPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-6 pt-5">
        <Download className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold">IG Downloader</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <IgDownloaderTab />
      </div>
    </div>
  )
}
