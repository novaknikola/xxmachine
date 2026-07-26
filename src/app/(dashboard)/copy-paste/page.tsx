'use client'

import { Copy } from 'lucide-react'
import { ReplicateTab } from './replicate-tab'

export default function CopyPastePage() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-6 pt-5 pb-3 border-b border-border">
        <Copy className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold">Copy-Paste</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <ReplicateTab />
      </div>
    </div>
  )
}
