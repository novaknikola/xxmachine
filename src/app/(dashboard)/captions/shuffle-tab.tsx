'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import { Upload, X, Loader2, FileSpreadsheet, Shuffle, Sparkles } from 'lucide-react'
import { extractCsvColumn } from '@/lib/csv'

const CSV_COLUMNS = ['captions', 'caption', 'text', 'on_screen_text']
const PLACEHOLDER_TEXTS = new Set(['(no on-screen text detected)', '(no speech detected)'])

/** Drops error/placeholder rows that shouldn't be fed to the AI. */
function isRealCaption(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (t.toLowerCase().startsWith('error:')) return false
  if (PLACEHOLDER_TEXTS.has(t.toLowerCase())) return false
  return true
}

interface LoadedFile {
  name: string
  texts: string[]
}

const STRENGTHS = [
  { value: 'light', label: 'Light', desc: 'Subtle wording tweaks' },
  { value: 'medium', label: 'Medium', desc: 'Noticeable rewording' },
  { value: 'heavy', label: 'Heavy', desc: 'Creative rewrite' },
] as const

const MODES = [
  { value: 'shuffle', label: 'Shuffle', icon: Shuffle },
  { value: 'generate', label: 'Generate New', icon: Sparkles },
] as const

export function ShuffleTab() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [mode, setMode] = useState<'shuffle' | 'generate'>('shuffle')
  const [files, setFiles] = useState<LoadedFile[]>([])
  const [strength, setStrength] = useState<'light' | 'medium' | 'heavy'>('medium')
  const [generateCount, setGenerateCount] = useState(200)
  const [hint, setHint] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const allTexts = files.flatMap(f => f.texts)

  async function addFiles(list: FileList | null) {
    if (!list) return
    for (const file of Array.from(list)) {
      try {
        const text = await file.text()
        const raw = extractCsvColumn(text, CSV_COLUMNS)
        const texts = raw.filter(isRealCaption)
        if (!texts.length) { toast.error(`${file.name}: no valid rows found`); continue }
        const skipped = raw.length - texts.length
        if (skipped > 0) toast.warning(`${file.name}: skipped ${skipped} error/placeholder row${skipped > 1 ? 's' : ''}`)
        setFiles(prev => [...prev, { name: file.name, texts }])
      } catch {
        toast.error(`${file.name}: could not read CSV`)
      }
    }
  }

  function removeFile(name: string) {
    setFiles(prev => prev.filter(f => f.name !== name))
  }

  async function submitShuffle() {
    if (!allTexts.length) { toast.error('Upload at least one CSV'); return }

    setSubmitting(true)
    try {
      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_type: 'caption_shuffle', input: { texts: allTexts, strength } }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Submit failed')

      const dupCount = data.originalCount - data.dedupedCount
      toast.success(`${data.dedupedCount} captions sent to queue`, {
        description: dupCount > 0 ? `${dupCount} duplicate${dupCount > 1 ? 's' : ''} removed before shuffling` : 'AI is rewriting each one to be unique',
        action: { label: 'Open Queue', onClick: () => router.push('/captions?tab=queue') },
      })
      setFiles([])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function submitGenerate() {
    if (!allTexts.length) { toast.error('Upload at least one CSV of example captions'); return }
    if (generateCount < 1) { toast.error('Enter how many captions to generate'); return }

    setSubmitting(true)
    try {
      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'caption_generate',
          input: { examples: allTexts, count: generateCount, hint: hint.trim() || undefined },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Submit failed')

      toast.success(`Generating ${generateCount} new captions`, {
        description: `Using ${data.exampleCount} example${data.exampleCount > 1 ? 's' : ''} as a style reference`,
        action: { label: 'Open Queue', onClick: () => router.push('/captions?tab=queue') },
      })
      setFiles([])
      setHint('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <div className="flex rounded-lg border border-border overflow-hidden text-sm w-fit mx-auto">
        {MODES.map(m => (
          <button key={m.value} onClick={() => setMode(m.value)}
            className={`px-4 py-1.5 flex items-center gap-1.5 transition-colors ${mode === m.value ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}>
            <m.icon className="w-3.5 h-3.5" />
            {m.label}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
            {mode === 'shuffle' ? 'CSV files (2 or more)' : 'Example CSV(s)'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <input ref={fileRef} type="file" accept=".csv,text/csv" multiple className="hidden"
            onChange={e => { addFiles(e.target.files); if (fileRef.current) fileRef.current.value = '' }} />
          <button onClick={() => fileRef.current?.click()}
            className="w-full border-2 border-dashed border-border rounded-xl p-5 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
            <Upload className="w-5 h-5" />
            <span className="text-sm">Upload CSV files</span>
            <span className="text-xs opacity-60">
              {mode === 'shuffle'
                ? 'One caption per row — same format as Transcribe/On-Screen Text exports'
                : 'Captions the AI will learn the style/format from'}
            </span>
          </button>

          {files.length > 0 && (
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {files.map(f => (
                <div key={f.name} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50">
                  <FileSpreadsheet className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 text-xs truncate">{f.name}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{f.texts.length} rows</span>
                  <button onClick={() => removeFile(f.name)} className="text-muted-foreground hover:text-destructive shrink-0">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {allTexts.length > 0 && (
            <p className="text-xs text-muted-foreground text-center">{allTexts.length} captions loaded from {files.length} file{files.length > 1 ? 's' : ''}</p>
          )}
        </CardContent>
      </Card>

      {mode === 'shuffle' && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Variation strength</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-2">
            {STRENGTHS.map(s => (
              <button key={s.value} onClick={() => setStrength(s.value)}
                className={`rounded-lg border p-3 text-left transition-colors ${strength === s.value ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40'}`}>
                <p className="text-sm font-medium">{s.label}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{s.desc}</p>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {mode === 'generate' && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">How many to generate</CardTitle>
            </CardHeader>
            <CardContent>
              <Input type="number" min={1} max={5000} value={generateCount}
                onChange={e => setGenerateCount(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
                className="h-9" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Guidance (optional)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Extra direction for the AI</Label>
              <Textarea
                value={hint}
                onChange={e => setHint(e.target.value)}
                rows={3}
                placeholder="e.g. keep it under 10 words, flirty tone, avoid mentioning age..."
                className="text-sm resize-none"
              />
            </CardContent>
          </Card>
        </>
      )}

      <Button className="w-full" onClick={mode === 'shuffle' ? submitShuffle : submitGenerate}
        disabled={submitting || allTexts.length === 0}>
        {submitting
          ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</>
          : mode === 'shuffle'
            ? <><Shuffle className="w-4 h-4 mr-2" />Dedupe & Shuffle ({allTexts.length})</>
            : <><Sparkles className="w-4 h-4 mr-2" />Generate {generateCount} New Captions</>}
      </Button>
      <p className="text-[10px] text-muted-foreground text-center">
        {mode === 'shuffle'
          ? 'Merges all files, removes exact duplicates, then AI rewrites each caption so none are identical.'
          : 'AI studies the uploaded examples and writes brand-new captions in the same style — not just reworded copies.'}
        {' '}Output is a single-column CSV, ready to re-upload to Bulk Captions.
      </p>
    </div>
  )
}
