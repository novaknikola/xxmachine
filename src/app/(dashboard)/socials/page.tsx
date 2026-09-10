'use client'

import { useState, useEffect } from 'react'
import { InstagramTab } from './instagram-tab'
import { ThreadsTab } from './threads-tab'
import { FacebookTab } from './facebook-tab'

export default function SocialsPage() {
  const [platform, setPlatform] = useState<'instagram' | 'threads' | 'facebook'>('instagram')

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('platform')
    if (p === 'threads') setPlatform('threads')
    else if (p === 'facebook') setPlatform('facebook')
  }, [])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-1 px-6 pt-5 pb-0 border-b border-border shrink-0">
        <button
          onClick={() => setPlatform('instagram')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
            platform === 'instagram'
              ? 'border-pink-500 text-pink-400'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Instagram
        </button>
        <button
          onClick={() => setPlatform('threads')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
            platform === 'threads'
              ? 'border-foreground text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Threads
        </button>
        <button
          onClick={() => setPlatform('facebook')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
            platform === 'facebook'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Facebook
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {platform === 'instagram' && <InstagramTab />}
        {platform === 'threads' && <ThreadsTab />}
        {platform === 'facebook' && <FacebookTab />}
      </div>
    </div>
  )
}
