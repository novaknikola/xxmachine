// Shared http(s) URL extractors — used by the content-script overlay and a
// node self-check. No DOM, no chrome.* so it can run in both worlds.

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim())
}

function normalizeHttpUrl(u) {
  if (typeof u !== 'string') return null
  const trimmed = u.trim()
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return null
  const withProto = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
  return isHttpUrl(withProto) ? withProto : null
}

// "a.jpg 1x, b.jpg 2x" / "a.jpg 100w, b.jpg 800w" — pick the largest descriptor.
function pickFromSrcset(srcset) {
  if (!srcset || typeof srcset !== 'string') return null
  let best = null
  let bestScore = -1
  for (const chunk of srcset.split(',')) {
    const parts = chunk.trim().split(/\s+/)
    const url = normalizeHttpUrl(parts[0])
    if (!url) continue
    const desc = parts[1] || ''
    const score = parseFloat(desc)
    const n = Number.isFinite(score) ? score : 1
    if (n >= bestScore) {
      best = url
      bestScore = n
    }
  }
  return best
}

// Pulls http(s) urls out of background-image / image-set CSS values.
function extractCssBgUrls(value) {
  if (!value || typeof value !== 'string') return []
  const out = []
  const re = /url\(\s*(['"]?)(\/\/[^'")\s]+|https?:\/\/[^'")\s]+)\1\s*\)/gi
  let m
  while ((m = re.exec(value))) {
    const url = normalizeHttpUrl(m[2])
    if (url && !out.includes(url)) out.push(url)
  }
  return out
}

function pickHttpImageUrl(parts) {
  const { currentSrc, src, srcset, dataSrc, sourceSrcsets } = parts || {}
  const fromSources = Array.isArray(sourceSrcsets)
    ? sourceSrcsets.map(pickFromSrcset)
    : []
  const candidates = [currentSrc, src, pickFromSrcset(srcset), ...fromSources, dataSrc]
  for (const c of candidates) {
    const url = normalizeHttpUrl(c)
    if (url) return url
  }
  return null
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isHttpUrl,
    normalizeHttpUrl,
    pickFromSrcset,
    extractCssBgUrls,
    pickHttpImageUrl,
  }
}
