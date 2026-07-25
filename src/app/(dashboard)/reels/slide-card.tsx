'use client'

import { useEffect, useRef } from 'react'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ImageIcon, Loader2, XCircle, ExternalLink, CheckCircle2, Trash2 } from 'lucide-react'
import { applyText, POSITION_OPTIONS, type TextPosition, type TextStyle } from '@/lib/canvas-utils'

export type SlideStatus = 'idle' | 'generating' | 'done' | 'error'

export interface Slide {
  index: number
  status: SlideStatus
  imageUrl: string
  caption: string          // supports \n for newlines
  position: TextPosition
  error?: string
}

export function SlideCard({
  slide, style, fontSizePx,
  onCaptionChange, onPositionChange, onDelete,
}: {
  slide: Slide; style: TextStyle; fontSizePx: number
  onCaptionChange: (idx: number, val: string) => void
  onPositionChange: (idx: number, val: TextPosition) => void
  onDelete: (idx: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (slide.status !== 'done' || !slide.imageUrl || !canvasRef.current) return
    const canvas = canvasRef.current
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      applyText(ctx, canvas.width, canvas.height, slide.caption, slide.position, style, fontSizePx)
    }
    img.src = slide.imageUrl
  }, [slide.status, slide.imageUrl, slide.caption, slide.position, style, fontSizePx])

  return (
    <div className="group relative rounded-xl border border-border/50 bg-card overflow-hidden flex flex-col">
      {/* Image area — 9:16 */}
      <div className="relative w-full aspect-[9/16] bg-secondary/30 overflow-hidden">
        {slide.status === 'idle' && (
          <div className="flex items-center justify-center h-full">
            <ImageIcon className="w-10 h-10 opacity-20 text-muted-foreground" />
          </div>
        )}
        {slide.status === 'generating' && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin" />
            <p className="text-xs">Generating...</p>
          </div>
        )}
        {slide.status === 'error' && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-destructive px-4 text-center">
            <XCircle className="w-8 h-8 opacity-50" />
            <p className="text-xs">{slide.error ?? 'Failed'}</p>
          </div>
        )}
        {slide.status === 'done' && (
          <div className="relative group/img w-full h-full">
            <canvas ref={canvasRef} className="w-full h-full object-cover transition-opacity group-hover/img:opacity-70" />
            <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover/img:opacity-100 transition-opacity bg-black/20">
              <a
                href={slide.imageUrl} target="_blank" rel="noopener noreferrer"
                className="w-7 h-7 rounded-full bg-black/60 flex items-center justify-center hover:bg-black/80 transition-colors"
                onClick={e => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3 text-white" />
              </a>
            </div>
          </div>
        )}

        {/* Slide number */}
        <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] font-bold px-2 py-0.5 rounded-full z-10">
          {slide.index + 1}
        </div>
        {slide.status === 'done' && (
          <div className="absolute top-2 left-2 z-10">
            <CheckCircle2 className="w-4 h-4 text-green-400 drop-shadow" />
          </div>
        )}
      </div>

      {/* Meta */}
      <div className="px-3 py-3 flex flex-col gap-2">
        <Textarea
          placeholder={`Slide ${slide.index + 1} caption...\nUse Enter for new line`}
          value={slide.caption}
          onChange={e => onCaptionChange(slide.index, e.target.value)}
          rows={3}
          className="text-sm resize-none"
        />
        <Select value={slide.position} onValueChange={v => onPositionChange(slide.index, v as TextPosition)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {POSITION_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Delete on hover */}
      <button
        onClick={() => onDelete(slide.index)}
        className="absolute top-10 right-2 w-6 h-6 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center hover:bg-destructive z-20"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  )
}
