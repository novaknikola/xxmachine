export function looksLikeDirectVideoUrl(url: string | null | undefined): boolean
export function findPlayableVideoUrl(data: unknown, depth?: number): string | null
export function extractPlayableVideoUrlFromHtml(html: string): string | null
export function isRapidApiPlanNoise(message: string): boolean
export function composeRecreateScrapeError(notes: Array<{ source: string; detail: string }>): string
