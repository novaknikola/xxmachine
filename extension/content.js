// Pinterest-style hover button: hover any <img> on any page, a small button
// appears over its corner, click it to save straight to XXmachine. A
// right-click "Sačuvaj sliku u XXmachine" context menu item (background.js)
// covers images this can't reach (very small ones, sites that block hover).

const MIN_SIZE = 60 // px — skip icons/avatars/tracking pixels

// Instagram lays a transparent element over every photo, so the pointer is
// never "on" the <img> there — neither for hover nor for right-click. On
// Instagram we look through that overlay at whatever image is under the
// pointer, and offer the "→ Photo Replicator" target next to the usual "+".
const ON_INSTAGRAM = /(^|\.)instagram\.com$/i.test(location.hostname)
const POST_LINK = 'a[href*="/p/"], a[href*="/reel/"]'

let hoveredImg = null
let hideTimer = null

const host = document.createElement('div')
host.style.all = 'initial'
document.documentElement.appendChild(host)
const shadow = host.attachShadow({ mode: 'closed' })

const style = document.createElement('style')
style.textContent = `
  .xm-btn {
    position: fixed;
    z-index: 2147483647;
    width: 34px;
    height: 34px;
    border-radius: 999px;
    background: #16a34a;
    color: #fff;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,.35);
    font: 600 16px system-ui, sans-serif;
    line-height: 1;
    transition: transform .1s ease, background .15s ease;
  }
  .xm-btn:hover { transform: scale(1.08); }
  .xm-btn[data-state="busy"] { background: #6b7280; cursor: wait; }
  .xm-btn[data-state="ok"] { background: #16a34a; }
  .xm-btn[data-state="err"] { background: #dc2626; }
  .xm-btn.xm-pr { width: auto; padding: 0 10px; background: #7c3aed; font-size: 12px; letter-spacing: .02em; }
  .xm-btn.xm-pr[data-state="busy"] { background: #6b7280; }
  .xm-btn.xm-pr[data-state="ok"] { background: #16a34a; }
  .xm-btn.xm-pr[data-state="err"] { background: #dc2626; }
  .xm-toast {
    position: fixed;
    z-index: 2147483647;
    right: 16px;
    bottom: 16px;
    max-width: 280px;
    padding: 10px 14px;
    border-radius: 10px;
    background: #111827;
    color: #fff;
    font: 500 13px system-ui, sans-serif;
    box-shadow: 0 4px 16px rgba(0,0,0,.4);
    opacity: 0;
    transform: translateY(6px);
    transition: opacity .15s ease, transform .15s ease;
  }
  .xm-toast[data-ok="false"] { background: #7f1d1d; }
  .xm-toast.show { opacity: 1; transform: translateY(0); }
`
shadow.appendChild(style)

const btn = document.createElement('button')
btn.className = 'xm-btn'
btn.type = 'button'
btn.title = 'Sačuvaj u XXmachine'
btn.textContent = '+'
btn.style.display = 'none'
shadow.appendChild(btn)

// Instagram only: send this photo to the Photo Replicator tab instead of Copy Prompts.
const prBtn = document.createElement('button')
prBtn.className = 'xm-btn xm-pr'
prBtn.type = 'button'
prBtn.title = '→ Photo Replicator'
prBtn.textContent = 'PR'
prBtn.style.display = 'none'
shadow.appendChild(prBtn)

const toastEl = document.createElement('div')
toastEl.className = 'xm-toast'
shadow.appendChild(toastEl)

let toastTimer = null
function showToast(text, ok) {
  toastEl.textContent = text
  toastEl.dataset.ok = String(ok)
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600)
}

function isEligible(img) {
  const rect = img.getBoundingClientRect()
  return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE
}

/** The topmost eligible <img> under a point, looking through overlays (Instagram). */
function imageAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el === host) continue
    if (el instanceof HTMLImageElement && isEligible(el)) return el
  }
  return null
}

function imageForEvent(e) {
  const direct = e.target instanceof Element ? e.target.closest('img') : null
  if (direct) return direct
  return ON_INSTAGRAM ? imageAt(e.clientX, e.clientY) : null
}

/**
 * The largest candidate the page offers, not the one this layout happened to
 * load: Instagram's currentSrc is often a 640px rendition of a 1080px photo.
 */
function bestSrc(img) {
  let best = null
  for (const part of (img.getAttribute('srcset') || '').split(/,\s+/)) {
    const [raw, descriptor] = part.trim().split(/\s+/)
    if (!raw) continue
    let url
    try {
      url = new URL(raw, location.href).href
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(url)) continue
    const size = parseFloat(descriptor) || 1 // "1080w" or "2x"
    if (!best || size > best.size) best = { url, size }
  }
  return best ? best.url : (img.currentSrc || img.src)
}

/**
 * The post a photo belongs to: its own link (grid, explore), the post link in
 * its feed article, or the page itself when the page is the post.
 */
function permalinkFor(img) {
  const own = img.closest(POST_LINK)
  if (own) return own.href
  const article = img.closest('article')
  const inArticle = article && article.querySelector(POST_LINK)
  if (inArticle) return inArticle.href
  if (/^\/(?:[^/]+\/)?(?:p|reel)\/[A-Za-z0-9_-]+/.test(location.pathname)) return location.href
  // Last resort: the nearest container holding exactly one post — more than one is a grid, not a post.
  for (let el = img.parentElement, depth = 0; el && depth < 12; el = el.parentElement, depth++) {
    const links = new Set([...el.querySelectorAll(POST_LINK)].map(a => a.href.split('?')[0]))
    if (links.size === 1) return [...links][0]
    if (links.size > 1) break
  }
  return ''
}

function photoReplicatorPayload(img) {
  return { imageUrl: bestSrc(img), pageUrl: location.href, permalink: permalinkFor(img), title: document.title }
}

function positionButton(img) {
  const rect = img.getBoundingClientRect()
  btn.style.top = `${Math.max(4, rect.top + 6)}px`
  btn.style.left = `${Math.min(window.innerWidth - 38, rect.right - 40)}px`
  if (ON_INSTAGRAM) {
    prBtn.style.top = btn.style.top
    prBtn.style.left = `${Math.min(window.innerWidth - 38, rect.right - 40) - 50}px`
  }
}

function showButton(img) {
  hoveredImg = img
  btn.dataset.state = 'idle'
  btn.textContent = '+'
  btn.style.display = 'flex'
  if (ON_INSTAGRAM) {
    prBtn.dataset.state = 'idle'
    prBtn.textContent = 'PR'
    prBtn.style.display = 'flex'
  }
  positionButton(img)
}

function scheduleHide() {
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    btn.style.display = 'none'
    prBtn.style.display = 'none'
    hoveredImg = null
  }, 180)
}

document.addEventListener('mouseover', e => {
  // Our own buttons: looking "through" them would re-show (and reset) them mid-click.
  if (e.target === host) return
  const img = imageForEvent(e)
  if (!img || !isEligible(img)) return
  clearTimeout(hideTimer)
  showButton(img)
}, true)

// Remembered for the "→ Photo Replicator" context-menu item: on Instagram the
// right-click lands on the overlay, so the browser itself reports no image.
let lastContext = null
document.addEventListener('contextmenu', e => {
  const img = imageForEvent(e)
  lastContext = img && isEligible(img) ? { img, at: Date.now() } : null
}, true)

document.addEventListener('mouseout', e => {
  const toEl = e.relatedTarget
  if (toEl === btn) return
  scheduleHide()
}, true)

btn.addEventListener('mouseenter', () => clearTimeout(hideTimer))
btn.addEventListener('mouseleave', scheduleHide)
prBtn.addEventListener('mouseenter', () => clearTimeout(hideTimer))
prBtn.addEventListener('mouseleave', scheduleHide)

window.addEventListener('scroll', () => { if (hoveredImg) positionButton(hoveredImg) }, true)
window.addEventListener('resize', () => { if (hoveredImg) positionButton(hoveredImg) })

btn.addEventListener('click', e => {
  e.preventDefault()
  e.stopPropagation()
  if (!hoveredImg || btn.dataset.state === 'busy') return

  const imageUrl = hoveredImg.currentSrc || hoveredImg.src
  if (!/^https?:\/\//i.test(imageUrl)) {
    btn.dataset.state = 'err'
    btn.textContent = '!'
    showToast('Ova slika se ne može sačuvati (nije obična http(s) slika).', false)
    setTimeout(() => { btn.dataset.state = 'idle'; btn.textContent = '+' }, 1400)
    return
  }

  btn.dataset.state = 'busy'
  btn.textContent = '…'

  chrome.runtime.sendMessage(
    { type: 'XM_CLIP_IMAGE', imageUrl, pageUrl: location.href, title: document.title },
    result => {
      if (chrome.runtime.lastError || !result) {
        btn.dataset.state = 'err'
        btn.textContent = '!'
        showToast('Greška pri čuvanju slike.', false)
      } else if (result.ok) {
        btn.dataset.state = 'ok'
        btn.textContent = '✓'
        showToast(result.alreadySaved ? 'Već sačuvano u XXmachine.' : 'Sačuvano u XXmachine.', true)
      } else {
        btn.dataset.state = 'err'
        btn.textContent = '!'
        showToast(result.error || 'Greška pri čuvanju slike.', false)
      }
      setTimeout(() => { btn.dataset.state = 'idle'; btn.textContent = '+' }, 1400)
    },
  )
})

function photoReplicatorToast(result) {
  if (result && result.ok) {
    const where = result.rowNumber ? ` (red ${result.rowNumber})` : ''
    showToast(result.alreadyInSheet ? `Već je u Photo Replicator${where}.` : `Dodato u Photo Replicator${where}.`, true)
  } else {
    showToast((result && result.error) || 'Photo Replicator: greška pri čuvanju.', false)
  }
}

prBtn.addEventListener('click', e => {
  e.preventDefault()
  e.stopPropagation()
  if (!hoveredImg || prBtn.dataset.state === 'busy') return
  const payload = photoReplicatorPayload(hoveredImg)
  if (!/^https?:\/\//i.test(payload.imageUrl)) {
    showToast('Ova slika se ne može poslati (nije obična http(s) slika).', false)
    return
  }
  prBtn.dataset.state = 'busy'
  prBtn.textContent = '…'
  chrome.runtime.sendMessage({ type: 'XM_PR_CLIP', ...payload }, result => {
    const failed = chrome.runtime.lastError || !result || !result.ok
    prBtn.dataset.state = failed ? 'err' : 'ok'
    prBtn.textContent = failed ? '!' : '✓'
    photoReplicatorToast(chrome.runtime.lastError ? null : result)
    setTimeout(() => { prBtn.dataset.state = 'idle'; prBtn.textContent = 'PR' }, 1400)
  })
})

// Feedback for the right-click "Sačuvaj sliku u XXmachine" context menu path,
// and for the popup's bulk "grab all images on this page" action.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'XM_CLIP_RESULT') {
    if (msg.ok) showToast(msg.alreadySaved ? 'Već sačuvano u XXmachine.' : 'Sačuvano u XXmachine.', true)
    else showToast(msg.error || 'Greška pri čuvanju slike.', false)
    return
  }

  // "→ Photo Replicator" context menu: which photo was right-clicked (the
  // browser cannot tell on Instagram — the click landed on the overlay).
  if (msg?.type === 'XM_PR_CONTEXT_IMAGE') {
    const img = lastContext && Date.now() - lastContext.at < 60_000 ? lastContext.img : null
    sendResponse(img && img.isConnected ? photoReplicatorPayload(img) : { error: 'Na tom mestu nema fotografije.' })
    return
  }

  if (msg?.type === 'XM_PR_RESULT') {
    photoReplicatorToast(msg)
    return
  }

  // The popup can't see the page's DOM itself — it asks the content script to
  // scan for eligible images (same size/http(s) rule as the hover button) and
  // hand back the deduped list.
  if (msg?.type === 'XM_SCAN_PAGE_IMAGES') {
    const seen = new Set()
    const urls = []
    document.querySelectorAll('img').forEach(img => {
      if (!isEligible(img)) return
      const src = img.currentSrc || img.src
      if (!/^https?:\/\//i.test(src) || seen.has(src)) return
      seen.add(src)
      urls.push(src)
    })
    sendResponse({ urls })
    return
  }
})
