'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { ConnectionTab } from './connection-tab'
import { TemplatesTab } from '../comfyui/templates-tab'
import { GenerateTab } from './generate-tab'
import { QueueTab } from './queue-tab'
import { Loader2, Server } from 'lucide-react'

const TABS = [
  { id: 'connection', label: 'Connection' },
  { id: 'generate', label: 'Generate' },
  { id: 'queue', label: 'Queue' },
  { id: 'templates', label: 'Templates' },
] as const

type TabId = (typeof TABS)[number]['id']

function isTab(v: string | null): v is TabId {
  return !!v && TABS.some(t => t.id === v)
}

function MyPodInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const tabParam = searchParams.get('tab')
  const [tab, setTab] = useState<TabId>(isTab(tabParam) ? tabParam : 'connection')

  useEffect(() => {
    if (isTab(tabParam)) setTab(tabParam)
  }, [tabParam])

  function go(id: TabId) {
    setTab(id)
    router.replace(`/my-pod?tab=${id}`, { scroll: false })
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Server className="w-5 h-5 text-primary" /> My Pod
          </h1>
          <p className="text-sm text-muted-foreground">
            Connect your RunPod via SSH + ComfyUI URL. Talk = Fish TTS + InfiniteTalk → Google Drive.
          </p>
        </div>

        <div className="flex gap-1 border-b border-border overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => go(t.id)}
              className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'connection' && <ConnectionTab />}
        {tab === 'templates' && <TemplatesTab />}
        {tab === 'generate' && <GenerateTab />}
        {tab === 'queue' && <QueueTab />}
      </div>
    </div>
  )
}

export default function MyPodPage() {
  return (
    <Suspense fallback={
      <div className="flex-1 flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    }>
      <MyPodInner />
    </Suspense>
  )
}
