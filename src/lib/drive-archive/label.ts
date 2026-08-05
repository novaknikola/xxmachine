/**
 * User-chosen names for archived files.
 *
 * Kept free of `node:` imports so client components can import it — the same
 * constraint content-format.ts already satisfies and bulk/page.tsx relies on.
 */

/**
 * Max characters kept from a user label. Keeps {label}_{NN}_{hash4}.{ext}
 * readable in Drive's list view while still fitting a real phrase like
 * "summer_rooftop_golden_hour".
 */
const MAX_LABEL_LEN = 48

/**
 * Filename/folder-safe user label.
 *
 * Same character class as sanitizeDriveKey, but returns '' instead of that
 * function's '_none' placeholder when nothing survives. The empty string is
 * load-bearing: it is the signal to fall back to the legacy machine-generated
 * name, which must stay byte-identical for every flow that sets no label.
 * A '_none' here would instead produce files literally called
 * `_none_01_a3f2.jpg`.
 */
export function sanitizeArchiveLabel(raw: string | null | undefined): string {
  const s = (raw ?? '')
    // Decompose first so "café" becomes "cafe" rather than losing the é entirely.
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Spaces, slashes, dots and emoji all collapse to a single underscore.
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
  return s.slice(0, MAX_LABEL_LEN).replace(/[_-]+$/, '')
}

/**
 * Copy-Paste label: who we copied plus which post.
 *
 * Derived rather than typed because a Copy-Paste run is a batch over unrelated
 * source reels — one typed name would label them all identically. This also
 * makes the raw original and its repurpose variants share a prefix, so they
 * line up by name across the raw/ and ready/ folders.
 */
export function copyPasteArchiveLabel(
  profile?: string | null,
  contentId?: string | null,
): string {
  const p = sanitizeArchiveLabel(profile)
  const c = sanitizeArchiveLabel(contentId).slice(0, 12)
  return [p, c].filter(Boolean).join('_')
}

/**
 * Drive subfolder for one set inside a batch: beach_vacation_01, _02, …
 *
 * Zero-padded because a batch can hold 25 carousels and `beach_vacation_10`
 * sorts before `beach_vacation_2` — which would defeat the whole point of
 * keeping a carousel in order. Always suffixed, even for a single set, so
 * adding a second one later does not produce a differently shaped folder.
 */
export function seriesFolderName(
  label: string | null | undefined,
  oneBasedIndex: number,
): string {
  const clean = sanitizeArchiveLabel(label)
  return clean ? `${clean}_${String(oneBasedIndex).padStart(2, '0')}` : ''
}
