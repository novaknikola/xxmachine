const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 11_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
]

const TIMEZONES = [
  'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Denver',
  'America/Phoenix', 'America/Toronto', 'America/Vancouver', 'America/Miami',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Warsaw', 'Europe/Stockholm', 'Europe/Zurich',
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Dubai',
  'Australia/Sydney', 'Australia/Melbourne',
]

const LOCALES = [
  'en-US', 'en-US', 'en-US', 'en-GB', 'en-GB', 'en-CA', 'en-AU',
  'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-BR', 'nl-NL', 'pl-PL',
]

const SCREENS = [
  { width: 1920, height: 1080 },
  { width: 1920, height: 1080 },
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 2560, height: 1440 },
  { width: 1600, height: 900 },
  { width: 1280, height: 720 },
]

const PLATFORMS = ['Win32', 'Win32', 'Win32', 'MacIntel', 'MacIntel', 'Linux x86_64']

const WEBGL_RENDERERS = [
  'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA GeForce RTX 2070 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Intel HD Graphics 4000 OpenGL Engine)',
  'ANGLE (Apple M1, OpenGL Engine)',
  'ANGLE (Apple M2, OpenGL Engine)',
]

function seededRandom(seed: string) {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i) | 0
  }
  return function (n: number) {
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) | 0
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) | 0
    return Math.abs(h ^ (h >>> 16)) % n
  }
}

export interface BrowserFingerprint {
  userAgent: string
  timezone: string
  locale: string
  screenWidth: number
  screenHeight: number
  platform: string
  webglRenderer: string
}

export function generateFingerprint(seed: string): BrowserFingerprint {
  const rand = seededRandom(seed)
  const screen = SCREENS[rand(SCREENS.length)]
  return {
    userAgent: USER_AGENTS[rand(USER_AGENTS.length)],
    timezone: TIMEZONES[rand(TIMEZONES.length)],
    locale: LOCALES[rand(LOCALES.length)],
    screenWidth: screen.width,
    screenHeight: screen.height,
    platform: PLATFORMS[rand(PLATFORMS.length)],
    webglRenderer: WEBGL_RENDERERS[rand(WEBGL_RENDERERS.length)],
  }
}
