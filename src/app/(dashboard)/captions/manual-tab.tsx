'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import { Upload, X, Loader2, ListTodo, Film, FileSpreadsheet, AlertTriangle, CheckCircle2, AlignLeft, Rows3 } from 'lucide-react'
import { CAPTION_STYLE_DEFS, type CaptionStyle } from '@/lib/captions'
import { extractCsvColumn } from '@/lib/csv'
import { uploadQueueInput } from '@/lib/upload-queue-input'
import { CaptionPositionPreview } from './caption-position-preview'
import { StylePreview, STYLES } from './style-preview'

const CSV_COLUMNS = ['captions', 'caption', 'text']

export function ManualTab() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const csvRef = useRef<HTMLInputElement>(null)

  const [files, setFiles] = useState<File[]>([])
  const [csvName, setCsvName] = useState<string | null>(null)
  const [csvTexts, setCsvTexts] = useState<string[]>([])
  const [textMode, setTextMode] = useState<'sequential' | 'static'>('sequential')
  const [style, setStyle] = useState<CaptionStyle>('tiktok')
  const [fontSize, setFontSize] = useState(CAPTION_STYLE_DEFS.tiktok.fontSize)
  const [posX, setPosX] = useState(50)
  const [posY, setPosY] = useState(80)
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function addFiles(list: FileList | null) {
    if (!list) return
    setFiles(prev => [...prev, ...Array.from(list)])
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  async function handleCsv(file: File | null) {
    if (!file) return
    try {
      const text = await file.text()
      const texts = extractCsvColumn(text, CSV_COLUMNS)
      if (!texts.length) {
        toast.error('CSV is empty or not in a recognizable format')
        return
      }
      setCsvName(file.name)
      setCsvTexts(texts)
      toast.success(`Loaded ${texts.length} rows from ${file.name}`)
    } catch {
      toast.error('Could not read CSV file')
    }
  }

  function selectStyle(s: CaptionStyle) {
    setStyle(s)
    setFontSize(CAPTION_STYLE_DEFS[s].fontSize)
  }

  const unmatchedVideos = Math.max(0, files.length - csvTexts.length)
  const unusedCsvRows = Math.max(0, csvTexts.length - files.length)
  const canSubmit = files.length > 0 && csvTexts.length > 0

  async function submit() {
    if (!files.length) { toast.error('Upload at least one video'); return }
    if (files.length > 200) { toast.error('Maximum 200 videos per submission'); return }
    if (!csvTexts.length) { toast.error('Upload a CSV with a captions column'); return }

    setSubmitting(true)
    try {
      toast.loading(`Uploading ${files.length} video${files.length > 1 ? 's' : ''}…`, { id: 'cap-manual-upload' })

      const items = []
      let failedCount = 0
      for (let i = 0; i < files.length; i++) {
        try {
          const { videoUrl, videoName } = await uploadQueueInput(files[i])
          items.push({ videoUrl, videoName, text: csvTexts[i] || undefined })
        } catch (err) {
          failedCount++
          console.error('[captions] upload failed:', err)
        }
      }
      toast.dismiss('cap-manual-upload')
      if (failedCount) toast.warning(`${failedCount} video${failedCount > 1 ? 's' : ''} skipped (corrupted or unreadable)`)
      if (!items.length) throw new Error('All uploads failed — nothing to submit')

      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'video_caption',
          input: {
            items,
            style,
            customStyle: { fontSize, posX, posY, videoWidth: dims?.width, videoHeight: dims?.height },
            textMode,
          },
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(e.error ?? 'Submit failed')
      }

      toast.success(`${items.length} video${items.length > 1 ? 's' : ''} sent to queue`, {
        description: 'Captions are being burned in the background using your CSV text',
        action: { label: 'Open Queue', onClick: () => router.push('/captions?tab=queue') },
      })
      setFiles([])
      setCsvName(null)
      setCsvTexts([])
    } catch (err) {
      toast.dismiss('cap-manual-upload')
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
      {/* Left panel */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">1. Videos (bulk)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <input ref={fileRef} type="file" accept="video/*" multiple className="hidden"
              onChange={e => { addFiles(e.target.files); if (fileRef.current) fileRef.current.value = '' }} />
            <button onClick={() => fileRef.current?.click()}
              className="w-full border-2 border-dashed border-border rounded-xl p-4 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
              <Upload className="w-5 h-5" />
              <span className="text-sm">Upload one or more videos</span>
              <span className="text-xs opacity-60">MP4, MOV · up to 200 at once</span>
            </button>

            {files.length > 0 && (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50">
                    <Film className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 text-xs truncate">{i + 1}. {f.name}</span>
                    <button onClick={() => removeFile(i)} className="text-muted-foreground hover:text-destructive shrink-0">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">2. CSV with captions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <input ref={csvRef} type="file" accept=".csv,text/csv" className="hidden"
              onChange={e => { handleCsv(e.target.files?.[0] ?? null); if (csvRef.current) csvRef.current.value = '' }} />
            <button onClick={() => csvRef.current?.click()}
              className="w-full border-2 border-dashed border-border rounded-xl p-4 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
              <FileSpreadsheet className="w-5 h-5" />
              <span className="text-sm">Upload CSV</span>
              <span className="text-xs opacity-60">column &quot;captions&quot; · 1 row = 1 video, in order</span>
            </button>
            {csvName && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 text-xs">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="flex-1 truncate">{csvName}</span>
                <span className="text-muted-foreground shrink-0">{csvTexts.length} rows</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">3. Text display</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setTextMode('sequential')}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all text-left ${textMode === 'sequential' ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40'}`}
              >
                <Rows3 className="w-4 h-4" />
                <span className="text-xs font-semibold">Sequential</span>
                <span className="text-[10px] text-muted-foreground text-center">Each line shown separately, one after another</span>
              </button>
              <button
                onClick={() => setTextMode('static')}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all text-left ${textMode === 'static' ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40'}`}
              >
                <AlignLeft className="w-4 h-4" />
                <span className="text-xs font-semibold">Whole text</span>
                <span className="text-[10px] text-muted-foreground text-center">All text at once, for the whole video duration</span>
              </button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Caption style</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-5 gap-2">
              {STYLES.map(([id, def]) => (
                <StylePreview key={id} id={id} def={def} active={style === id} onClick={() => selectStyle(id)} />
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Font size</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <input
              type="range" min={20} max={120} value={fontSize}
              onChange={e => setFontSize(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <p className="text-xs text-muted-foreground text-center">{fontSize}px</p>
          </CardContent>
        </Card>

        <Button className="w-full" onClick={submit} disabled={submitting || !canSubmit}>
          {submitting
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</>
            : <><ListTodo className="w-4 h-4 mr-2" />Queue Burn-in ({files.length})</>}
        </Button>
        {unmatchedVideos > 0 && (
          <p className="text-[10px] text-muted-foreground text-center">
            {unmatchedVideos} video{unmatchedVideos > 1 ? 's' : ''} without a CSV row — will be auto-transcribed
          </p>
        )}
        {unusedCsvRows > 0 && (
          <p className="text-[10px] text-muted-foreground text-center">
            {unusedCsvRows} extra CSV row{unusedCsvRows > 1 ? 's' : ''} — won&apos;t be used
          </p>
        )}
      </div>

      {/* Right — pairing preview + position */}
      <div className="space-y-6">
        {(files.length > 0 || csvTexts.length > 0) && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Pairing (in order)</CardTitle>
                {(unmatchedVideos > 0 || unusedCsvRows > 0) && (
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <AlertTriangle className="w-3 h-3" />Not 1:1, but that&apos;s fine
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {Array.from({ length: Math.max(files.length, csvTexts.length) }).map((_, i) => (
                  <div key={i} className={`flex items-start gap-2 text-xs px-3 py-2 rounded-lg ${!files[i] ? 'opacity-40' : !csvTexts[i] ? 'bg-amber-500/10' : 'bg-secondary/40'}`}>
                    <span className="text-muted-foreground shrink-0 w-5">{i + 1}.</span>
                    <span className="w-32 truncate shrink-0" title={files[i]?.name}>{files[i]?.name ?? <em>no video (CSV row unused)</em>}</span>
                    <span className="flex-1 truncate text-muted-foreground" title={csvTexts[i]}>
                      {csvTexts[i] ? csvTexts[i].split('\n')[0] : files[i] ? <em>auto-transcription</em> : ''}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Caption position</CardTitle>
          </CardHeader>
          <CardContent>
            <CaptionPositionPreview
              videoFile={files[0] ?? null}
              posX={posX}
              posY={posY}
              fontSize={fontSize}
              onChange={(x, y) => { setPosX(x); setPosY(y) }}
              onDimensions={(w, h) => setDims({ width: w, height: h })}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
