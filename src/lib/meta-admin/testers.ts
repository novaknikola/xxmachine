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

/**
 * Diagnostic-only: the dialog screenshot showed 6 role radios (Administrator,
 * Developer, Tester, Analytics User, Instagram Tester, Threads Tester in that
 * visual order) but no visible field to type a username anywhere in it —
 * testing whether picking "Instagram Tester" (5th radio, confirmed by
 * screenshot) reveals one, since the "Search..." input the previous dump
 * found is more likely the global top-nav search than anything in this
 * dialog (page.$$eval scans the whole page, not just the modal).
 */
export async function clickInstagramTesterRadioAndDump(page: Page): Promise<void> {
  const radios = await page.$$('input[type="radio"]')
  if (radios.length < 5) {
    console.log('[meta-admin-testers] DEBUG: expected >=5 radios, found', radios.length)
    return
  }
  await radios[4].click()
  await page.waitForTimeout(1500)
  await debugScreenshot(page, 'roles-03-instagram-tester-selected')

  const inputs = await page.$$eval('input, textarea', els => els.map(e => ({
    tag: e.tagName,
    type: e.getAttribute('type'),
    placeholder: e.getAttribute('placeholder'),
    ariaLabel: e.getAttribute('aria-label'),
  })))
  console.log('[meta-admin-testers] DEBUG inputs after selecting Instagram Tester:', JSON.stringify(inputs, null, 2))
}

const USERNAME_FIELD_SELECTOR = 'input[placeholder="Enter the username of the Instagram account you want to add"]'

/**
 * Adds an Instagram account as an Instagram Tester on the app. Built from
 * live evidence, not guessed: Add People -> 5th role radio (Instagram
 * Tester, confirmed by screenshot to reveal a dedicated username field
 * distinct from the Facebook-identity search above it) -> type username ->
 * Add. Unverified past the username field appearing — the actual submit
 * (autocomplete/suggestion behavior, success confirmation) has not been
 * exercised live yet.
 */
/**
 * Meta's own anti-abuse rate limiter for this dashboard action — confirmed
 * live (2026-08-13) after ~8 rapid Add People submissions in a row: a
 * "You're Temporarily Blocked — It looks like you were misusing this
 * feature by going too fast" modal appears and every subsequent add fails
 * with an opaque "Add (submit) button not found" (the button is there, this
 * modal is just covering it). Callers should stop the whole batch on this,
 * not keep retrying — hammering a live rate limit only risks extending it.
 */
export class MetaRateLimitedError extends Error {
  constructor() { super('Meta has temporarily blocked Add People for going too fast') }
}

async function checkNotRateLimited(page: Page): Promise<void> {
  const blocked = await page.$('text="You\'re Temporarily Blocked"')
  if (!blocked) return
  const closeBtn = await page.$('button:has-text("Close"), [role="button"]:has-text("Close")')
  if (closeBtn) await closeBtn.click().catch(() => {})
  throw new MetaRateLimitedError()
}

export async function addInstagramTester(page: Page, appId: string, igUsername: string): Promise<void> {
  await goToRolesPage(page, appId)

  const addPeopleBtn = await page.$('button:has-text("Add People"), [role="button"]:has-text("Add People")')
  if (!addPeopleBtn) throw new Error('Add People button not found')
  await addPeopleBtn.click()
  await page.waitForTimeout(1500)
  await checkNotRateLimited(page)

  const radios = await page.$$('input[type="radio"]')
  if (radios.length < 5) throw new Error(`Expected >=5 role radios, found ${radios.length}`)
  await radios[4].click()
  await page.waitForTimeout(1000)

  const usernameField = await page.waitForSelector(USERNAME_FIELD_SELECTOR, { timeout: 10000 })
  await usernameField.click()
  await usernameField.type(igUsername, { delay: 80 + Math.random() * 60 })
  await page.waitForTimeout(2000)
  await debugScreenshot(page, `add-tester-${igUsername}-filled`)
  await checkNotRateLimited(page)

  // Exact text-match on igUsername doesn't work: Instagram's typeahead
  // renders its own normalized display string (e.g. dots become underscores),
  // which never equals the raw input. Confirmed live that the dropdown rows
  // are `role="option"` divs whose `id` is the account's numeric IG user id
  // — position (first = best match, same ranking Instagram itself shows) is
  // the reliable signal, not text. Leaving the dropdown open by finding no
  // match was the actual bug: the open list then intercepts the Add button
  // click underneath it.
  const suggestionRowId = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('div[role="option"][id]'))
      .find(el => /^\d+$/.test(el.id))
    return row ? row.id : null
  })
  if (suggestionRowId) {
    await page.click(`[id="${suggestionRowId}"]`)
    await page.waitForTimeout(1000)
  } else {
    // No suggestion rendered — make sure no leftover dropdown is still open
    // and intercepting the Add button.
    await usernameField.press('Escape').catch(() => {})
  }

  const addBtn = await page.$('button:has-text("Add"):not(:has-text("People")), [role="button"]:has-text("Add"):not(:has-text("People"))')
  if (!addBtn) throw new Error('Add (submit) button not found after filling username')
  await addBtn.click()
  await page.waitForTimeout(2500)
  await debugScreenshot(page, `add-tester-${igUsername}-after-submit`)
}
