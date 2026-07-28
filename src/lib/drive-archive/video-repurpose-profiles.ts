import type { VideoEffectOpts } from '@/lib/video-ffmpeg'
import type { ContentFormat } from './content-format'

/** FFmpeg effect toggles per publish format. */
export const VIDEO_REPURPOSE_OPTS: Record<'reels' | 'stories', VideoEffectOpts> = {
  reels: {
    brightness: true,
    contrast: true,
    saturation: true,
    hue: false,
    speed: true,
    flipH: true,
    crop: true,
    fade: true,
  },
  stories: {
    brightness: true,
    contrast: true,
    saturation: true,
    hue: false,
    speed: false,
    flipH: true,
    crop: true,
    fade: true,
  },
}

export function videoOptsForFormat(format: ContentFormat): VideoEffectOpts {
  if (format === 'stories') return VIDEO_REPURPOSE_OPTS.stories
  return VIDEO_REPURPOSE_OPTS.reels
}
