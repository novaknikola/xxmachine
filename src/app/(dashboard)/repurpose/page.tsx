'use client'

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { ReproduceTab } from './reproduce-tab'
import { VideoReproduceTab } from './video-reproduce-tab'

const TAB_LABELS = ['Image', 'Video'] as const
type Tab = typeof TAB_LABELS[number]

export default function RepurposePage() {
  const [tab, setTab] = useState<Tab>('Image')

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-6 pt-5">
        <RefreshCw className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold">Repurpose</h1>
      </div>

      <div className="flex border-b border-border shrink-0 px-6 pt-3 gap-1 bg-background">
        {TAB_LABELS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'Image' && <ReproduceTab />}
        {tab === 'Video' && <VideoReproduceTab />}
      </div>
    </div>
  )
}
