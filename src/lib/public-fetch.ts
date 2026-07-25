import { lookup } from 'node:dns/promises'

/**
 * Guards the image/video proxy routes against SSRF. Users are allowed to paste
 * arbitrary public URLs, so a host allowlist is not an option — instead we
 * refuse anything that resolves into the machine or the private network.
 */

const MAX_REDIRECTS = 3

export class UnsafeUrlError extends Error {}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local, includes cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // carrier NAT
  if (a >= 224) return true // multicast and reserved
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]
  if (addr === '::' || addr === '::1') return true
  // IPv4-mapped (::ffff:1.2.3.4) — judge by the embedded IPv4.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIPv4(mapped[1])
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true // unique local
  if (addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) {
    return true // link-local
  }
  return false
}

function isPrivateAddress(ip: string, family: number): boolean {
  return family === 4 ? isPrivateIPv4(ip) : isPrivateIPv6(ip)
}

/** Throws `UnsafeUrlError` unless the URL is http(s) and resolves to a public address. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeUrlError('Invalid URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http and https URLs are allowed')
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UnsafeUrlError('Host is not publicly routable')
  }

  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new UnsafeUrlError('Host could not be resolved')
  }

  if (!addresses.length || addresses.some(a => isPrivateAddress(a.address, a.family))) {
    throw new UnsafeUrlError('Host is not publicly routable')
  }

  return url
}

/**
 * `fetch` restricted to public hosts. Redirects are followed manually so every
 * hop is re-validated — a public URL redirecting to 127.0.0.1 is rejected.
 */
export async function fetchPublicUrl(raw: string, init?: RequestInit): Promise<Response> {
  let current = raw
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current)
    const res = await fetch(url, { ...init, redirect: 'manual' })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res
      current = new URL(location, url).toString()
      continue
    }
    return res
  }
  throw new UnsafeUrlError('Too many redirects')
}
