'use client'

import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Server } from 'lucide-react'
import { TemplatesTab } from './templates-tab'
import { GenerateTab } from './generate-tab'
import { QueueTab } from './queue-tab'
import { ReplicateTab } from './replicate-tab'

const TAB_LABELS = ['Replicate', 'Templates', 'Bulk Generate', 'Queue'] as const
type Tab = typeof TAB_LABELS[number]

function ComfyUIPageInner() {
  const params = useSearchParams()
  const tabParam = params.get('tab')
  const initialTab: Tab =
    tabParam === 'queue' ? 'Queue'
    : tabParam === 'templates' ? 'Templates'
    : tabParam === 'generate' ? 'Bulk Generate'
    : 'Replicate'
  const [tab, setTab] = useState<Tab>(initialTab)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-6 pt-5">
        <Server className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold">Copy-Paste</h1>
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
        {tab === 'Replicate' && <ReplicateTab />}
        {tab === 'Templates' && <TemplatesTab />}
        {tab === 'Bulk Generate' && <GenerateTab />}
        {tab === 'Queue' && <QueueTab />}
      </div>
    </div>
  )
}

export default function ComfyUIPage() {
  return (
    <Suspense fallback={null}>
      <ComfyUIPageInner />
    </Suspense>
  )
}
