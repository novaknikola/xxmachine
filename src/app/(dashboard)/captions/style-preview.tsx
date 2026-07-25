'use client'

import { CAPTION_STYLE_DEFS, type CaptionStyle } from '@/lib/captions'

export const STYLES = Object.entries(CAPTION_STYLE_DEFS) as [CaptionStyle, typeof CAPTION_STYLE_DEFS[CaptionStyle]][]

export function StylePreview({ id, def, active, onClick }: {
  id: CaptionStyle
  def: typeof CAPTION_STYLE_DEFS[CaptionStyle]
  active: boolean
  onClick: () => void
}) {
  const previewStyle: React.CSSProperties = {
    fontFamily: def.font === 'Impact' ? 'Impact, fantasy' : def.font === 'Georgia' ? 'Georgia, serif' : 'Arial, sans-serif',
    fontSize: `${Math.round(def.fontSize * 0.25)}px`,
    fontWeight: def.bold ? 800 : def.italic ? 400 : def.font === 'Impact' ? 900 : 400,
    fontStyle: def.italic ? 'italic' : 'normal',
    color: def.primaryColor === '&H00FFFFFF&' ? 'white'
      : def.primaryColor === '&H0000FFFF&' ? '#FFFF00'
      : def.primaryColor === '&H0000D7FF&' ? '#FFD700'
      : 'white',
    textShadow: def.outline > 0 ? `0 0 ${def.outline * 2}px black, 0 0 ${def.outline}px black` : 'none',
    backgroundColor: def.borderStyle === 3 ? 'rgba(0,0,0,0.65)' : 'transparent',
    padding: def.borderStyle === 3 ? '4px 8px' : '2px 4px',
    textTransform: def.uppercase ? 'uppercase' : 'none',
    letterSpacing: def.font === 'Impact' ? '0.05em' : 'normal',
    borderRadius: def.borderStyle === 3 ? '3px' : 0,
  }

  return (
    <button
      onClick={onClick}
      className={`relative rounded-xl border-2 transition-all overflow-hidden bg-zinc-900 ${
        active ? 'border-primary shadow-[0_0_0_3px_rgba(var(--primary)/0.2)]' : 'border-border hover:border-primary/40'
      }`}
    >
      <div className="aspect-[9/16] flex flex-col items-center justify-center p-2">
        <div style={previewStyle} className="text-center leading-tight">
          {def.uppercase ? 'HELLO WORLD' : 'Hello world'}
        </div>
      </div>
      <div className="absolute bottom-0 inset-x-0 bg-black/70 py-1 text-center">
        <span className={`text-[10px] font-semibold ${active ? 'text-primary' : 'text-muted-foreground'}`}>
          {def.label}
        </span>
      </div>
    </button>
  )
}
