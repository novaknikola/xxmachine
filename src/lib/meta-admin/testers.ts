import type { Page } from 'playwright-core'
import { debugScreenshot } from './browser'

/** developers.facebook.com's Roles page URL pattern — confirmed live, not guessed. */
export function rolesUrl(appId: string): string {
  return `https://developers.facebook.com/apps/${appId}/roles/roles/`
}

export async function goToRolesPage(page: Page, appId: string): Promise<void> {
  await page.goto(rolesUrl(appId), { waitUntil: 'networkidle', timeout: 30000 })
  await debugScreenshot(page, 'roles-01-landing')
}

/**
 * Diagnostic-only: dumps every button-like element's visible text so real
 * selectors can be written from evidence, not guesses. Phase 1 (login) burned
 * five iterations guessing selectors blind — not repeating that here.
 */
export async function dumpButtons(page: Page): Promise<void> {
  const buttons = await page.$$eval(
    'button, [role="button"], a',
    els => els
      .map(e => ({ tag: e.tagName, text: (e as HTMLElement).innerText?.trim().slice(0, 60), role: e.getAttribute('role') }))
      .filter(b => b.text),
  )
  console.log('[meta-admin-testers] DEBUG clickable elements:', JSON.stringify(buttons, null, 2))
}
