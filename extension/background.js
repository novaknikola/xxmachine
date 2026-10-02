// Service worker: owns the actual network call to XXmachine, since the
// content script's fetch would be subject to the page's own CSP (many sites
// block cross-origin fetch outright) while a request made here, with
// host_permissions covering the target, is not.

const MENU_ID = 'xxmachine-clip-image'
// Instagram only. The right-click there lands on an overlay, not the photo, so
// the item is offered on the page/link too and the content script says which
// photo was under the pointer.
const PR_MENU_ID = 'xxmachine-photo-replicator'
const INSTAGRAM_PAGES = ['https://www.instagram.com/*', 'https://instagram.com/*']

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first: reloading the extension runs this again, and re-creating an
  // existing id is an error.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Sačuvaj sliku u XXmachine',
      contexts: ['image'],
    })
    chrome.contextMenus.create({
      id: PR_MENU_ID,
      title: '→ Photo Replicator',
      contexts: ['page', 'link', 'image'],
      documentUrlPatterns: INSTAGRAM_PAGES,
    })
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

/** The Photo Replicator tab: the server re-hosts the photo and adds a Sheet row. */
async function clipToPhotoReplicator(payload) {
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
      body: JSON.stringify({
        target: 'photo-replicator',
        imageUrl: payload.imageUrl,
        pageUrl: payload.pageUrl,
        permalink: payload.permalink,
        title: payload.title,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || `Greška ${res.status}` }
    return { ok: true, rowNumber: data.rowNumber, alreadyInSheet: !!data.alreadyInSheet }
  } catch {
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
  if (info.menuItemId === PR_MENU_ID && tab?.id) {
    const resolved = await chrome.tabs
      .sendMessage(tab.id, { type: 'XM_PR_CONTEXT_IMAGE' }, { frameId: info.frameId ?? 0 })
      .catch(() => null)
    // The content script knows the photo under the overlay; a plain image the
    // browser itself recognised is the fallback.
    const payload = resolved && resolved.imageUrl
      ? resolved
      : info.srcUrl
        ? { imageUrl: info.srcUrl, pageUrl: tab.url || '', permalink: info.linkUrl || '', title: tab.title || '' }
        : null
    const result = payload
      ? await clipToPhotoReplicator(payload)
      : { ok: false, error: (resolved && resolved.error) || 'Na tom mestu nema fotografije.' }
    chrome.tabs.sendMessage(tab.id, { type: 'XM_PR_RESULT', ...result }).catch(() => {})
    return
  }

  if (info.menuItemId !== MENU_ID || !info.srcUrl || !tab?.id) return
  const result = await clipImage(info.srcUrl, tab.url || '', tab.title || '')
  if (result.ok) void bumpBadge()
  chrome.tabs.sendMessage(tab.id, { type: 'XM_CLIP_RESULT', ...result }).catch(() => {})
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'XM_CLIP_IMAGE') {
    clipImage(msg.imageUrl, msg.pageUrl, msg.title).then(result => {
      if (result.ok) void bumpBadge()
      sendResponse(result)
    })
    return true // keep the message channel open for the async response
  }

  // Sent by the "PR" hover button on Instagram.
  if (msg?.type === 'XM_PR_CLIP') {
    clipToPhotoReplicator(msg).then(sendResponse)
    return true
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
