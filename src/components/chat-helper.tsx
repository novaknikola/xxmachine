'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { MessageCircle, X, Send, Loader2, Sparkles, Copy, Trash2 } from 'lucide-react'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

const STORAGE_KEY = 'xm_chat_helper'

const STARTERS = [
  'Improve this prompt: front camera selfie at the gym',
  'Suggest 3 angles for a beach POV photo',
  'Translate to English and tighten: ona pravi selfie u liftu posle treninga',
]

function load(): ChatMessage[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function save(messages: ChatMessage[]) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`group relative max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${
          isUser
            ? 'bg-primary/15 text-foreground border border-primary/30'
            : 'bg-white/[0.03] text-foreground/90 border border-white/8'
        }`}
      >
        {message.content}
        {!isUser && (
          <button
            onClick={() => {
              navigator.clipboard.writeText(message.content)
              toast.success('Copied')
            }}
            className="absolute -top-2 -right-2 hidden group-hover:flex items-center justify-center w-6 h-6 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground"
            aria-label="Copy"
          >
            <Copy className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  )
}

export function ChatHelper() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages(load())
  }, [])

  useEffect(() => {
    save(messages)
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, open])

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || loading) return

    const next: ChatMessage[] = [...messages, { role: 'user', content: trimmed }]
    setMessages(next)
    setInput('')
    setLoading(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Chat error')
      setMessages([...next, { role: 'assistant', content: data.reply }])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Chat failed')
      setMessages(next)
    } finally {
      setLoading(false)
    }
  }

  function clearChat() {
    setMessages([])
    save([])
    toast.success('Chat cleared')
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 h-12 w-12 rounded-full bg-primary text-primary-foreground shadow-lg shadow-black/40 flex items-center justify-center hover:scale-105 transition-transform glow-primary"
          aria-label="Open prompt helper"
        >
          <Sparkles className="w-5 h-5" />
        </button>
      )}

      {open && (
        <div className="fixed bottom-5 right-5 z-50 w-[min(92vw,360px)] h-[min(70vh,520px)] flex flex-col rounded-2xl border border-primary/25 glass-input shadow-2xl shadow-black/50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
            <div className="flex items-center gap-2">
              <div className="grid h-7 w-7 place-items-center rounded-lg bg-primary/15 border border-primary/30 text-primary">
                <MessageCircle className="w-4 h-4" />
              </div>
              <div>
                <p className="text-xs font-semibold text-foreground">Prompt helper</p>
                <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Free · Gemini 2.5 Flash</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={clearChat}
                  aria-label="Clear chat"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground/80 px-1">
                  Paste a prompt, ask for ideas, or translate. Try:
                </p>
                <div className="space-y-1.5">
                  {STARTERS.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => send(s)}
                      className="w-full text-left rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-foreground/90 hover:border-primary/40 hover:bg-primary/10 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => <MessageBubble key={i} message={m} />)}
            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl px-3 py-2 bg-white/[0.03] border border-white/8 text-xs text-muted-foreground inline-flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Thinking…
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={e => { e.preventDefault(); send(input) }}
            className="border-t border-white/5 p-2 flex items-end gap-2"
          >
            <Textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send(input)
                }
              }}
              placeholder="Ask for prompt help…"
              rows={2}
              className="bg-input border-white/10 text-xs resize-none min-h-0 py-2 rounded-xl"
            />
            <Button
              type="submit"
              size="sm"
              disabled={loading || !input.trim()}
              className="h-9 w-9 p-0 bg-primary text-primary-foreground glow-primary shrink-0 rounded-xl"
              aria-label="Send"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            </Button>
          </form>
        </div>
      )}
    </>
  )
}
