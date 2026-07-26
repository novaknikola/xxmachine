'use client'

import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Captions as CaptionsIcon } from 'lucide-react'
import { UploadTab } from './upload-tab'
import { ManualTab } from './manual-tab'
import { TranscribeTab } from './transcribe-tab'
import { OcrTab } from './ocr-tab'
import { ShuffleTab } from './shuffle-tab'
import { QueueTab } from './queue-tab'

const TAB_LABELS = ['Add Captions', 'Bulk Captions', 'Transcribe Audio', 'On-Screen Text', 'Caption Shuffle', 'Queue'] as const
type Tab = typeof TAB_LABELS[number]

function CaptionsPageInner() {
  const params = useSearchParams()
  const tabParam = params.get('tab')
  const initialTab: Tab =
    tabParam === 'queue' ? 'Queue'
    : tabParam === 'bulk' ? 'Bulk Captions'
    : tabParam === 'transcribe' ? 'Transcribe Audio'
    : tabParam === 'ocr' ? 'On-Screen Text'
    : tabParam === 'shuffle' ? 'Caption Shuffle'
    : 'Add Captions'
  const [tab, setTab] = useState<Tab>(initialTab)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-6 pt-5">
        <CaptionsIcon className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold">Video Studio</h1>
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
        {tab === 'Add Captions' && <UploadTab />}
        {tab === 'Bulk Captions' && <ManualTab />}
        {tab === 'Transcribe Audio' && <TranscribeTab />}
        {tab === 'On-Screen Text' && <OcrTab />}
        {tab === 'Caption Shuffle' && <ShuffleTab />}
        {tab === 'Queue' && <QueueTab />}
      </div>
    </div>
  )
}

export default function CaptionsPage() {
  return (
    <Suspense fallback={null}>
      <CaptionsPageInner />
    </Suspense>
  )
}
