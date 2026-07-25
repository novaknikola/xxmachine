export interface CaptionWord {
  text: string
  start: number  // seconds
  end: number    // seconds
}

export interface CaptionSegment {
  id: string
  text: string
  start: number
  end: number
  words: CaptionWord[]
}

export type CaptionStyle = 'tiktok' | 'hormozi' | 'podcast' | 'minimal' | 'luxury'

export interface StyleDef {
  label: string
  font: string
  fontSize: number
  primaryColor: string   // &HAABBGGRR& — highlighted / main text
  secondaryColor: string // &HAABBGGRR& — karaoke pre-highlight color
  outlineColor: string
  backColor: string
  borderStyle: number   // 1=outline, 3=opaque box
  outline: number       // outline width (px)
  shadow: number
  bold: boolean
  italic: boolean
  alignment: number     // numpad 1-9
  marginV: number
  uppercase: boolean
  karaoke: boolean
}

export const CAPTION_STYLE_DEFS: Record<CaptionStyle, StyleDef> = {
  tiktok: {
    label: 'TikTok',
    font: 'Impact',
    fontSize: 64,
    primaryColor: '&H00FFFFFF&',    // white (highlighted word)
    secondaryColor: '&H80808080&',  // gray (other words)
    outlineColor: '&H00000000&',
    backColor: '&H00000000&',
    borderStyle: 1,
    outline: 3,
    shadow: 0,
    bold: false,
    italic: false,
    alignment: 5,  // center-middle
    marginV: 0,
    uppercase: true,
    karaoke: true,
  },
  hormozi: {
    label: 'Hormozi',
    font: 'Arial',
    fontSize: 56,
    primaryColor: '&H0000FFFF&',    // yellow
    secondaryColor: '&H80FFFFFF&',  // dim white
    outlineColor: '&H00000000&',
    backColor: '&H00000000&',
    borderStyle: 1,
    outline: 3,
    shadow: 0,
    bold: true,
    italic: false,
    alignment: 2,  // bottom-center
    marginV: 120,
    uppercase: true,
    karaoke: true,
  },
  podcast: {
    label: 'Podcast',
    font: 'Arial',
    fontSize: 44,
    primaryColor: '&H00FFFFFF&',
    secondaryColor: '&H80808080&',
    outlineColor: '&H00000000&',
    backColor: '&HAA000000&',  // semi-transparent black box
    borderStyle: 3,
    outline: 0,
    shadow: 0,
    bold: false,
    italic: false,
    alignment: 2,
    marginV: 80,
    uppercase: false,
    karaoke: false,
  },
  minimal: {
    label: 'Minimal',
    font: 'Arial',
    fontSize: 38,
    primaryColor: '&H00FFFFFF&',
    secondaryColor: '&H80808080&',
    outlineColor: '&H60000000&',  // very subtle outline
    backColor: '&H00000000&',
    borderStyle: 1,
    outline: 1,
    shadow: 0,
    bold: false,
    italic: false,
    alignment: 2,
    marginV: 80,
    uppercase: false,
    karaoke: false,
  },
  luxury: {
    label: 'Luxury',
    font: 'Georgia',
    fontSize: 40,
    primaryColor: '&H0000D7FF&',   // gold (BGR: B=00, G=D7, R=FF)
    secondaryColor: '&H80808080&',
    outlineColor: '&H60000000&',
    backColor: '&H80000000&',
    borderStyle: 1,
    outline: 1,
    shadow: 1,
    bold: false,
    italic: true,
    alignment: 2,
    marginV: 80,
    uppercase: false,
    karaoke: false,
  },
}

function toAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const cs = Math.round((seconds % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export interface CaptionCustomStyle {
  fontSize?: number
  posX?: number         // 0-100, % of video width — center of the caption box
  posY?: number         // 0-100, % of video height
  videoWidth?: number   // real source video px width, for accurate \pos mapping
  videoHeight?: number
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function generateAssFile(
  segments: CaptionSegment[],
  style: CaptionStyle,
  customStyle?: CaptionCustomStyle,
): string {
  const def = CAPTION_STYLE_DEFS[style]
  const fontSize = customStyle?.fontSize ? clamp(Math.round(customStyle.fontSize), 20, 120) : def.fontSize

  const hasPos = customStyle?.posX !== undefined && customStyle?.posY !== undefined
  const playResX = customStyle?.videoWidth ?? 1080
  const playResY = customStyle?.videoHeight ?? 1920
  const posTag = hasPos
    ? `{\\an5\\pos(${Math.round(clamp(customStyle!.posX!, 8, 92) / 100 * playResX)},${Math.round(clamp(customStyle!.posY!, 8, 92) / 100 * playResY)})}`
    : ''

  const styleLine = [
    'Style: Default',
    def.font,
    fontSize,
    def.primaryColor,
    def.secondaryColor,
    def.outlineColor,
    def.backColor,
    def.bold ? '-1' : '0',
    def.italic ? '-1' : '0',
    '0', '0',          // underline, strikeout
    '100', '100', '0', '0',  // scaleX, scaleY, spacing, angle
    def.borderStyle,
    def.outline,
    def.shadow,
    def.alignment,
    '20', '20', def.marginV,  // margins
    '1',  // encoding
  ].join(',')

  const events = segments.map(seg => {
    let text: string

    if (def.karaoke && seg.words.length > 0) {
      text = seg.words.map(w => {
        const cs = Math.max(1, Math.round((w.end - w.start) * 100))
        const word = def.uppercase ? w.text.trim().toUpperCase() : w.text.trim()
        return `{\\kf${cs}}${word}`
      }).join(' ')
    } else {
      const raw = def.uppercase ? seg.text.trim().toUpperCase() : seg.text.trim()
      text = raw.replace(/\n/g, '\\N')  // ASS forced line break within one caption box
    }

    return `Dialogue: 0,${toAssTime(seg.start)},${toAssTime(seg.end)},Default,,0,0,0,,${posTag}${text}`
  }).join('\n')

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}`
}

/** Splits manually-pasted text into one segment per non-empty line, evenly spread across the video's duration. */
export function buildManualSegments(text: string, videoDuration: number): CaptionSegment[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0 || videoDuration <= 0) return []

  const perLine = videoDuration / lines.length
  return lines.map((line, i) => ({
    id: Math.random().toString(36).slice(2),
    text: line,
    start: i * perLine,
    end: (i + 1) * perLine,
    words: [],
  }))
}

/** Whole pasted text as a single static caption spanning the entire video — no per-line timing. */
export function buildStaticSegment(text: string, videoDuration: number): CaptionSegment[] {
  const trimmed = text.trim()
  if (!trimmed || videoDuration <= 0) return []

  return [{
    id: Math.random().toString(36).slice(2),
    text: trimmed,
    start: 0,
    end: videoDuration,
    words: [],
  }]
}

export function groupWordsIntoSegments(
  words: CaptionWord[],
  maxWords = 4,
  maxDuration = 3.0,
): CaptionSegment[] {
  const segments: CaptionSegment[] = []
  let current: CaptionWord[] = []

  for (const word of words) {
    const trimmed = word.text.trim()
    if (!trimmed) continue

    if (
      current.length > 0 &&
      (current.length >= maxWords ||
        word.end - current[0].start > maxDuration)
    ) {
      segments.push(wordsToSegment(current))
      current = []
    }
    current.push({ ...word, text: trimmed })
  }

  if (current.length > 0) segments.push(wordsToSegment(current))
  return segments
}

function wordsToSegment(words: CaptionWord[]): CaptionSegment {
  return {
    id: Math.random().toString(36).slice(2),
    text: words.map(w => w.text).join(' '),
    start: words[0].start,
    end: words[words.length - 1].end,
    words,
  }
}
