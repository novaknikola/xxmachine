// Service worker: owns the actual network call to XXmachine, since the
// content script's fetch would be subject to the page's own CSP (many sites
// block cross-origin fetch outright) while a request made here, with
// host_permissions covering the target, is not.

const MENU_ID = 'xxmachine-clip-image'
const CONTENT_FILES = ['image-url.js', 'content.js']

function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Sačuvaj sliku u XXmachine',
      contexts: ['image'],
    }, () => {
      void chrome.runtime.lastError
    })
  })
}

function isInjectableUrl(url) {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' || u.protocol === 'edge:' || u.protocol === 'about:' || u.protocol === 'devtools:') {
      return false
    }
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

async function injectIntoTab(tabId, url) {
  if (!tabId || !isInjectableUrl(url)) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_FILES,
    })
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: CONTENT_FILES,
      })
    } catch {
      // restricted page (PDF viewer, Chrome Web Store, …)
    }
  }
}

async function injectAllTabs() {
  const tabs = await chrome.tabs.query({})
  await Promise.all(tabs.map(tab => (tab.id ? injectIntoTab(tab.id, tab.url) : Promise.resolve())))
}

ensureContextMenu()
chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu()
  void injectAllTabs()
})
chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu()
  void injectAllTabs()
})

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') void injectIntoTab(tabId, tab.url)
})

async function getConfig() {
  const { apiBase, token } = await chrome.storage.local.get(['apiBase', 'token'])
  return { apiBase: (apiBase || '').replace(/\/+$/, ''), token: token || '' }
}

async function clipImage(imageUrl, pageUrl, title) {
  const { apiBase, token } = await getConfig()
  if (!apiBase || !token) {
    return { ok: false, error: 'Ekstenzija nije podešena — otvori Options i unesi URL sajta i token.' }
  }
  try {
    const res = await fetch(`${apiBase}/api/extension/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ imageUrl, pageUrl, title }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || `Greška ${res.status}` }
    return { ok: true, alreadySaved: !!data.alreadySaved }
  } catch (err) {
    return { ok: false, error: 'Ne mogu da dosegnem server — proveri URL sajta u Options.' }
  }
}

async function clipImages(imageUrls, folder, pageUrl, title) {
  const { apiBase, token } = await getConfig()
  if (!apiBase || !token) {
    return { ok: false, error: 'Ekstenzija nije podešena — otvori Options i unesi URL sajta i token.' }
  }
  try {
    const res = await fetch(`${apiBase}/api/extension/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ imageUrls, folder: folder || undefined, pageUrl, title }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || `Greška ${res.status}` }
    return { ok: true, saved: data.saved ?? 0, alreadySaved: data.alreadySaved ?? 0, total: data.total ?? imageUrls.length }
  } catch (err) {
    return { ok: false, error: 'Ne mogu da dosegnem server — proveri URL sajta u Options.' }
  }
}

async function bumpBadge(by = 1) {
  const { clipCount } = await chrome.storage.local.get('clipCount')
  const next = (clipCount || 0) + by
  await chrome.storage.local.set({ clipCount: next })
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' })
  chrome.action.setBadgeText({ text: String(Math.min(next, 99)) })
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl || !tab?.id) return
  const result = await clipImage(info.srcUrl, tab.url || '', tab.title || '')
  if (result.ok) void bumpBadge()
  chrome.tabs.sendMessage(tab.id, { type: 'XM_CLIP_RESULT', ...result }).catch(() => {})
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'XM_ENSURE_CONTENT') {
    const tabId = sender.tab?.id ?? msg.tabId
    const url = sender.tab?.url ?? msg.url
    injectIntoTab(tabId, url).then(() => sendResponse({ ok: true }))
    return true
  }

  if (msg?.type === 'XM_CLIP_IMAGE') {
    clipImage(msg.imageUrl, msg.pageUrl, msg.title).then(result => {
      if (result.ok) void bumpBadge()
      sendResponse(result)
    })
    return true // keep the message channel open for the async response
  }

  // Sent by the popup's "Grab all images on this page" button.
  if (msg?.type === 'XM_CLIP_BULK') {
    clipImages(msg.imageUrls, msg.folder, msg.pageUrl, msg.title).then(result => {
      if (result.ok) void bumpBadge(result.saved)
      sendResponse(result)
    })
    return true
  }

  return undefined
})
