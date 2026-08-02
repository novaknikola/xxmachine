'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { BrowseTab } from './browse-tab'
import { BatchesTab } from './batches-tab'

const TABS = ['browse', 'batches'] as const
type Tab = typeof TABS[number]

function isTab(v: string | null): v is Tab {
  return (TABS as readonly string[]).includes(v ?? '')
}

function CopyPromptsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryTab = searchParams.get('tab')
  const [tab, setTab] = useState<Tab>(isTab(queryTab) ? queryTab : 'browse')

  useEffect(() => {
    if (isTab(queryTab) && queryTab !== tab) setTab(queryTab)
  }, [queryTab, tab])

  function changeTab(next: Tab) {
    setTab(next)
    router.replace(`/copy-prompts${next === 'browse' ? '' : `?tab=${next}`}`)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-4 px-5 py-3 border-b border-border shrink-0 bg-background">
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          <button
            onClick={() => changeTab('browse')}
            className={`px-4 py-1.5 transition-colors ${tab === 'browse' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            Browse
          </button>
          <button
            onClick={() => changeTab('batches')}
            className={`px-4 py-1.5 transition-colors ${tab === 'batches' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            Batches
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'browse' && <BrowseTab />}
        {tab === 'batches' && <BatchesTab />}
      </div>
    </div>
  )
}

export default function CopyPromptsPage() {
  return (
    <Suspense fallback={null}>
      <CopyPromptsPageInner />
    </Suspense>
  )
}
