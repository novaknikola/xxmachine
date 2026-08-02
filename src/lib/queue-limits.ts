/**
 * Submission caps shared by the queue route and the forms that feed it, so the
 * UI can show the limit up front instead of the server rejecting a filled-in
 * panel.
 *
 * These are cost guards, not runtime ones. Copy Prompts jobs resume from
 * done_items and write a progressAt heartbeat after every batch, so a long run
 * simply finishes across several cron passes.
 */

/** Ceiling on images one Copy Prompts job may generate — each is a paid Seedream call. */
export const MAX_SEEDREAM_SLIDES_PER_JOB = 150

/** Z-image turbo is cheap and fast enough not to need the same guard. */
export const MAX_TURBO_ITEMS = 100

/**
 * How many items fit in one submission. With a carousel each item costs
 * 1 + variants slides, so the item budget shrinks as the carousel grows.
 */
export function maxItemsForJob(opts: {
  usesSeedream: boolean
  carouselCount?: number | null
}): number {
  if (!opts.usesSeedream) return MAX_TURBO_ITEMS
  const slidesPerItem = opts.carouselCount ? 1 + opts.carouselCount : 1
  return Math.floor(MAX_SEEDREAM_SLIDES_PER_JOB / slidesPerItem)
}
