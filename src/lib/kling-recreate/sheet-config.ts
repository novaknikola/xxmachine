/**
 * The "Scripts" sheet the user has actually been using since the start of
 * this project (also where the separate Python reels-analiza idea-bank
 * pipeline writes, via the same service account) — NOT the pre-existing
 * viral-monitor sheet this feature's Sheet output was previously, silently,
 * inherited into. Literal constant, not an env var, so no manual VPS
 * .env.local step is needed on deploy.
 */
export const RECREATE_SHEET_ID = '1pRU63hrIoCNTOQ1qE9pB45mHneLYOyULmWXm_6Y0Mgc'
