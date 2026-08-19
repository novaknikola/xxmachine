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
  // An exact-text selector quoting a straight ASCII apostrophe never matched
  // live — confirmed 2026-08-14, this exact modal showing clearly in a
  // screenshot while the check silently passed and the run kept hammering
  // an already-active block for ~19 more accounts. Meta's actual DOM text
  // almost certainly uses a typographic apostrophe (’, U+2019), not '.
  // Matching "Temporarily Blocked" alone sidesteps the character entirely.
  const blocked = await page.$('text=Temporarily Blocked')
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

  // Raw text-match on igUsername doesn't work: Instagram's typeahead renders
  // its own normalized display string (e.g. dots become underscores), which
  // never equals the raw input. Previously this just took the first
  // `role="option"` row by DOM position, trusting Instagram's own search
  // ranking — confirmed live 2026-08-19 that's unsafe: for a username with
  // no real exact match, Instagram's search surfaced an unrelated real
  // account ("beckett_browning6" for a search on "beckett.browning") as the
  // top result, and it got silently invited as a Tester. That's someone
  // else's real account getting an unsolicited notification — worse than
  // just failing the add. Now requires the candidate's own text to equal
  // the query after both are normalized (lowercased, non-alphanumeric
  // stripped) — if nothing matches exactly, this throws instead of
  // guessing. Confirmed to still work for the underscore-substitution case
  // (e.g. "hina.rin54" -> displayed "hina_rin54" still normalizes equal).
  const candidates = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div[role="option"][id]'))
      .filter(el => /^\d+$/.test(el.id))
      .map(el => ({ id: el.id, text: (el as HTMLElement).innerText || '' }))
  })
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const target = normalize(igUsername)
  const match = candidates.find(c => normalize(c.text) === target)

  if (!match) {
    await debugScreenshot(page, `add-tester-${igUsername}-no-exact-match`)
    const seen = candidates.map(c => c.text).join(', ') || '(no suggestions at all)'
    throw new Error(`No exact-matching Instagram account for "${igUsername}" — search showed: ${seen}. Not guessing to avoid inviting the wrong account.`)
  }
  await page.click(`[id="${match.id}"]`)
  await page.waitForTimeout(1000)

  const addBtn = await page.$('button:has-text("Add"):not(:has-text("People")), [role="button"]:has-text("Add"):not(:has-text("People"))')
  if (!addBtn) throw new Error('Add (submit) button not found after filling username')
  await addBtn.click()
  await page.waitForTimeout(2500)
  await debugScreenshot(page, `add-tester-${igUsername}-after-submit`)
}
