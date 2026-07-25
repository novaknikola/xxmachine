'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { Move } from 'lucide-react'

interface CaptionPositionPreviewProps {
  videoFile: File | null
  posX: number
  posY: number
  fontSize: number
  onChange: (posX: number, posY: number) => void
  onDimensions?: (width: number, height: number) => void
}

const MIN_PCT = 8
const MAX_PCT = 92

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function CaptionPositionPreview({
  videoFile, posX, posY, fontSize, onChange, onDimensions,
}: CaptionPositionPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [aspect, setAspect] = useState(9 / 16)
  const dragging = useRef(false)

  useEffect(() => {
    if (!videoFile) { setVideoUrl(null); return }
    const url = URL.createObjectURL(videoFile)
    setVideoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [videoFile])

  function handleLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget
    v.currentTime = Math.min(0.1, v.duration / 2)
    if (v.videoWidth && v.videoHeight) {
      setAspect(v.videoWidth / v.videoHeight)
      onDimensions?.(v.videoWidth, v.videoHeight)
    }
  }

  const updateFromPointer = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = clamp(((clientX - rect.left) / rect.width) * 100, MIN_PCT, MAX_PCT)
    const y = clamp(((clientY - rect.top) / rect.height) * 100, MIN_PCT, MAX_PCT)
    onChange(Math.round(x), Math.round(y))
  }, [onChange])

  function onPointerDown(e: React.PointerEvent) {
    dragging.current = true
    ;(e.target as Element).setPointerCapture(e.pointerId)
    updateFromPointer(e.clientX, e.clientY)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return
    updateFromPointer(e.clientX, e.clientY)
  }
  function onPointerUp(e: React.PointerEvent) {
    dragging.current = false
    ;(e.target as Element).releasePointerCapture(e.pointerId)
  }

  return (
    <div className="space-y-1.5">
      <div
        ref={containerRef}
        className="relative mx-auto rounded-xl overflow-hidden border border-border bg-black select-none"
        style={{ aspectRatio: aspect, maxHeight: 420, width: aspect < 1 ? 'auto' : '100%', height: aspect < 1 ? 420 : 'auto' }}
      >
        {videoUrl ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={videoUrl}
            className="w-full h-full object-cover pointer-events-none"
            muted
            playsInline
            onLoadedMetadata={handleLoadedMetadata}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
            Upload a video to see the preview
          </div>
        )}

        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="absolute cursor-grab active:cursor-grabbing touch-none flex items-center gap-1 px-2 py-1 rounded bg-black/70 border border-primary/60 text-white font-bold uppercase whitespace-nowrap"
          style={{
            left: `${posX}%`,
            top: `${posY}%`,
            transform: 'translate(-50%, -50%)',
            fontSize: Math.max(10, Math.min(28, fontSize / 3)),
          }}
        >
          <Move className="w-3 h-3 shrink-0 opacity-70" />
          Your text here
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground text-center">Drag the box to set the caption position</p>
    </div>
  )
}
