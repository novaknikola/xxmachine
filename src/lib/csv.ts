/**
 * Repairs "mojibake" — text that was originally valid UTF-8 but got decoded as
 * Latin-1 at some point (classic symptom of a CSV round-tripped through Excel or a
 * naive text reader), producing garbage like "â€™" instead of "'". Bails out and
 * returns the input unchanged if it doesn't look like recoverable mojibake, so
 * normal accented text is never touched.
 */
export function fixMojibake(text: string): string {
  let hasNonAscii = false
  for (let i = 0; i < text.length; i++) { if (text.charCodeAt(i) > 0x7F) { hasNonAscii = true; break } }
  if (!hasNonAscii) return text // pure ASCII, nothing to fix

  const bytes: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp > 0xFF) return text // not representable as a single Latin-1 byte — not this kind of mojibake
    bytes.push(cp)
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
  } catch {
    return text // reinterpreting as UTF-8 produced invalid bytes — wasn't mojibake
  }
}

/** RFC4180-ish CSV parser — handles quoted fields, embedded commas/newlines, and "" escaped quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { pushField(); rows.push(row); row = [] }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += c
      }
      continue
    }

    if (c === '"') { inQuotes = true; continue }
    if (c === ',') { pushField(); continue }
    if (c === '\r') continue
    if (c === '\n') { pushRow(); continue }
    field += c
  }
  if (field.length > 0 || row.length > 0) pushRow()

  return rows.filter(r => r.some(cell => cell.trim().length > 0))
}

/**
 * Extracts one caption-per-row from a CSV without requiring an exact header name.
 * - Single-column CSV: every row is used as-is (header row auto-skipped only if its
 *   one cell happens to match a known column name — otherwise treated as data).
 * - Multi-column CSV: picks the header that best matches a known name (exact or
 *   partial), falling back to the last column if nothing recognizable is found.
 */
export function extractCsvColumn(text: string, knownNames: string[]): string[] {
  const rows = parseCsv(text)
  if (rows.length === 0) return []

  if (rows.every(r => r.length === 1)) {
    const first = (rows[0][0] ?? '').trim().toLowerCase()
    const isHeaderRow = knownNames.includes(first)
    return (isHeaderRow ? rows.slice(1) : rows).map(r => fixMojibake(r[0] ?? ''))
  }

  const headers = rows[0].map(h => h.trim().toLowerCase())
  let idx = headers.findIndex(h => knownNames.some(name => h === name))
  if (idx === -1) idx = headers.findIndex(h => knownNames.some(name => h.includes(name)))
  if (idx === -1) idx = headers.length - 1

  return rows.slice(1).map(r => fixMojibake(r[idx] ?? ''))
}

function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`
  return field
}

/** Serializes rows into RFC4180-ish CSV text, quoting fields that need it. */
export function toCsv(rows: string[][]): string {
  return rows.map(row => row.map(csvEscape).join(',')).join('\r\n')
}
