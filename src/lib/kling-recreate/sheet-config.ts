/**
 * Sheet the recreate bot's Analysis/Ideas/Bulk Queue tabs write to — moved
 * here 2026-09-19 per explicit user request, away from the "Scripts" sheet
 * (which this feature briefly used, and before that a pre-existing viral-
 * monitor sheet it was silently, wrongly inherited into). Literal constant,
 * not an env var, so no manual VPS .env.local step is needed on deploy.
 */
export const RECREATE_SHEET_ID = '1nzHi3xWy3yzjXVyvDPC79W15f76OobVHgdtNa69uF1E'
