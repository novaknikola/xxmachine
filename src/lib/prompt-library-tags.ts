/** Global prompt library — prompts tagged by source/theme, not tied to one character. */

export const GLOBAL_CHARACTER_ID = '__global__'

export function slugifyTag(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function bundleTags(bundleLabel: string, source: 'grok-generated' | 'static-bundle' = 'grok-generated'): string[] {
  return [source, slugifyTag(bundleLabel)]
}
