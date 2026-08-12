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

/**
 * Diagnostic-only: clicks "Add People" (confirmed live to be a
 * div[role="button"], same pattern as every other Meta/Facebook control
 * found this session) and dumps the resulting dialog's inputs and clickable
 * elements, so the actual add-tester flow can be built from evidence.
 */
export async function clickAddPeopleAndDump(page: Page): Promise<void> {
  const addPeopleBtn = await page.$('button:has-text("Add People"), [role="button"]:has-text("Add People")')
  if (!addPeopleBtn) {
    console.log('[meta-admin-testers] DEBUG: Add People button not found')
    return
  }
  await addPeopleBtn.click()
  await page.waitForTimeout(2000)
  await debugScreenshot(page, 'roles-02-add-people-dialog')

  const inputs = await page.$$eval('input, textarea', els => els.map(e => ({
    tag: e.tagName,
    type: e.getAttribute('type'),
    placeholder: e.getAttribute('placeholder'),
    ariaLabel: e.getAttribute('aria-label'),
    role: e.getAttribute('role'),
  })))
  console.log('[meta-admin-testers] DEBUG dialog inputs:', JSON.stringify(inputs, null, 2))

  const clickables = await page.$$eval('button, [role="button"], [role="checkbox"], [role="radio"], a', els => els
    .map(e => ({ tag: e.tagName, text: (e as HTMLElement).innerText?.trim().slice(0, 60), role: e.getAttribute('role') }))
    .filter(b => b.text || b.role === 'checkbox' || b.role === 'radio'))
  console.log('[meta-admin-testers] DEBUG dialog clickables:', JSON.stringify(clickables, null, 2))
}
