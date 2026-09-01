// Service worker: owns the actual network call to XXmachine, since the
// content script's fetch would be subject to the page's own CSP (many sites
// block cross-origin fetch outright) while a request made here, with
// host_permissions covering the target, is not.

const MENU_ID = 'xxmachine-clip-image'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Sačuvaj sliku u XXmachine',
    contexts: ['image'],
  })
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

async function bumpBadge() {
  const { clipCount } = await chrome.storage.local.get('clipCount')
  const next = (clipCount || 0) + 1
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
  if (msg?.type !== 'XM_CLIP_IMAGE') return undefined
  clipImage(msg.imageUrl, msg.pageUrl, msg.title).then(result => {
    if (result.ok) void bumpBadge()
    sendResponse(result)
  })
  return true // keep the message channel open for the async response
})
