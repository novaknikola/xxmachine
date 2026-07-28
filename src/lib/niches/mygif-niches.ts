/**
 * MyGIF scraped niches — separate namespace from brand NICHE_DEFINITIONS.
 * Never merge into Admin character niche picker.
 */

import type { NicheDefinition } from '@/lib/niche-utils'
import { MYGIF_NICHE_DEFINITIONS as GENERATED } from './mygif-generated'

export {
  MYGIF_GENERATED_AT,
  MYGIF_SOURCE_IDS,
} from './mygif-generated'

export const MYGIF_NICHE_DEFINITIONS: NicheDefinition[] = GENERATED

export function isMyGifNicheId(id: string): boolean {
  return id.startsWith('mygif-')
}

export function getMyGifNicheById(id: string): NicheDefinition | undefined {
  return MYGIF_NICHE_DEFINITIONS.find((n) => n.id === id)
}

/** Tags when saving MyGIF niche prompts into prompt_library. */
export function mygifLibraryTags(nicheId: string): string[] {
  return ['static-bundle', 'mygif', nicheId, 'full-feed']
}
