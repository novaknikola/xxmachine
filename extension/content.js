// Hover overlay: a green "+" over the painted image under the pointer
// (regular <img>, <picture>, or a large element's CSS background-image).
// Right-click "Sačuvaj sliku u XXmachine" (background.js) still covers
// cases this can't reach. Pairing / POST /api/extension/clip is unchanged.

const MIN_SIZE = 60 // px — skip icons/avatars/tracking pixels

if (window.__xmClipper) {
  // already injected (manifest + scripting.executeScript can both fire)
} else if (shouldSkipDocument()) {
  // chrome://, the extension's own pages, empty documents
} else {
  window.__xmClipper = true
  try {
    boot()
  } catch {
    window.__xmClipper = false
  }
}

function shouldSkipDocument() {
  const proto = location.protocol
  if (proto === 'chrome:' || proto === 'chrome-extension:' || proto === 'edge:' || proto === 'devtools:') {
    return true
  }
  return !document.documentElement
}

function boot() {
  let hovered = null // { el, url }
  let hideTimer = null
  let lastX = 0
  let lastY = 0
  let hasPointer = false
  let raf = 0
  let moTimer = 0

  const host = mountHost()
  const shadow = host ? attachOverlay(host) : null
  const btn = shadow?.btn || null
  const toastEl = shadow?.toastEl || null

  let toastTimer = null
  function showToast(text, ok) {
    if (!toastEl) return
    toastEl.textContent = text
    toastEl.dataset.ok = String(ok)
    toastEl.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600)
  }

  function isLargeEnough(el) {
    if (!(el instanceof Element)) return false
    const rect = el.getBoundingClientRect()
    return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE
  }

  function pickHttpImageUrlFromImg(img) {
    const sourceSrcsets = []
    const pic = img.closest?.('picture')
    if (pic) {
      pic.querySelectorAll('source[srcset]').forEach(s => sourceSrcsets.push(s.getAttribute('srcset')))
    }
    return pickHttpImageUrl({
      currentSrc: img.currentSrc,
      src: img.src,
      srcset: img.getAttribute('srcset') || img.srcset,
      dataSrc: img.getAttribute('data-src')
        || img.getAttribute('data-original')
        || img.getAttribute('data-lazy-src')
        || img.getAttribute('data-pin-media'),
      sourceSrcsets,
    })
  }

  function pickHttpImageUrlFromPicture(pic) {
    const img = pic.querySelector('img')
    if (img) return pickHttpImageUrlFromImg(img)
    const sourceSrcsets = []
    pic.querySelectorAll('source[srcset]').forEach(s => sourceSrcsets.push(s.getAttribute('srcset')))
    return pickHttpImageUrl({ sourceSrcsets })
  }

  function pickHttpBgUrl(el) {
    try {
      const bg = getComputedStyle(el).backgroundImage
      const urls = extractCssBgUrls(bg)
      return urls[0] || null
    } catch {
      return null
    }
  }

  function containsPoint(el, x, y, pad = 12) {
    const r = el.getBoundingClientRect()
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
  }

  function inspectElement(el) {
    if (!(el instanceof Element)) return null
    if (el === document.documentElement || el === document.body) return null
    const tag = el.tagName
    if (tag === 'IMG') {
      if (!isLargeEnough(el)) return null
      const url = pickHttpImageUrlFromImg(el)
      return url ? { el, url } : null
    }
    if (tag === 'PICTURE' || tag === 'SOURCE') {
      const pic = tag === 'PICTURE' ? el : el.closest('picture')
      if (!pic) return null
      const img = pic.querySelector('img')
      const box = img && isLargeEnough(img) ? img : isLargeEnough(pic) ? pic : null
      if (!box) return null
      const url = img ? pickHttpImageUrlFromImg(img) : pickHttpImageUrlFromPicture(pic)
      return url ? { el: img || pic, url } : null
    }
    if (isLargeEnough(el)) {
      const url = pickHttpBgUrl(el)
      if (url) return { el, url }
    }
    return null
  }

  function bestImgIn(node) {
    if (!node || !node.querySelectorAll) return null
    let best = null
    let bestArea = 0
    node.querySelectorAll('img').forEach(img => {
      if (!isLargeEnough(img)) return
      if (!pickHttpImageUrlFromImg(img)) return
      const r = img.getBoundingClientRect()
      const area = r.width * r.height
      if (area > bestArea) {
        best = img
        bestArea = area
      }
    })
    return best
  }

  function findTargetAt(x, y) {
    let stack
    try {
      stack = document.elementsFromPoint(x, y)
    } catch {
      return null
    }
    if (!stack || !stack.length) return null

    for (const el of stack) {
      if (host && (el === host || host.contains(el))) continue
      const hit = inspectElement(el)
      if (hit) return hit
    }

    // Pinterest / Instagram paint a transparent overlay on top of the image.
    // Walk a few ancestors and pick the largest saveable <img> that still
    // contains the pointer — never body/html, or the + sticks on empty space.
    for (const el of stack) {
      if (host && (el === host || host.contains(el))) continue
      let node = el
      for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
        if (node === document.body || node === document.documentElement) break
        const img = bestImgIn(node)
        if (img && containsPoint(img, x, y)) {
          const url = pickHttpImageUrlFromImg(img)
          if (url) return { el: img, url }
        }
        if (isLargeEnough(node) && containsPoint(node, x, y)) {
          const bg = pickHttpBgUrl(node)
          if (bg) return { el: node, url: bg }
        }
      }
    }
    return null
  }

  function positionButton(el) {
    if (!btn) return
    const rect = el.getBoundingClientRect()
    btn.style.top = `${Math.max(4, rect.top + 6)}px`
    btn.style.left = `${Math.min(window.innerWidth - 38, rect.right - 40)}px`
  }

  function showButton(hit) {
    if (!btn || !host) return
    hovered = hit
    btn.dataset.state = 'idle'
    btn.textContent = '+'
    btn.style.display = 'flex'
    host.setAttribute('data-xm-visible', '1')
    positionButton(hit.el)
  }

  function hideButton() {
    if (!btn || !host) return
    btn.style.display = 'none'
    host.removeAttribute('data-xm-visible')
    hovered = null
  }

  function scheduleHide() {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hideButton, 180)
  }

  function updateFromPoint(x, y) {
    if (btn && btn.dataset.state === 'busy') return
    const hit = findTargetAt(x, y)
    if (hit) {
      clearTimeout(hideTimer)
      showButton(hit)
    } else if (hovered) {
      scheduleHide()
    }
  }

  function onPointerMove(e) {
    if (host && (e.target === host || host.contains(e.target))) return
    hasPointer = true
    lastX = e.clientX
    lastY = e.clientY
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      updateFromPoint(lastX, lastY)
    })
  }

  document.addEventListener('pointermove', onPointerMove, { passive: true, capture: true })
  document.addEventListener('pointerleave', () => {
    hasPointer = false
    scheduleHide()
  }, true)

  window.addEventListener('scroll', () => {
    if (hovered) positionButton(hovered.el)
    if (hasPointer) updateFromPoint(lastX, lastY)
  }, true)
  window.addEventListener('resize', () => {
    if (hovered) positionButton(hovered.el)
  })

  // SPA feeds swap tiles under a still cursor — re-hit-test last pointer pos.
  if (document.documentElement) {
    const mo = new MutationObserver(() => {
      if (!hasPointer) return
      clearTimeout(moTimer)
      moTimer = setTimeout(() => updateFromPoint(lastX, lastY), 80)
    })
    try {
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'style'],
      })
    } catch {
      // some documents reject MutationObserver — hover still works
    }
  }

  if (btn) {
    btn.addEventListener('pointerenter', () => clearTimeout(hideTimer))
    btn.addEventListener('pointerleave', scheduleHide)
    btn.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      if (!hovered || btn.dataset.state === 'busy') return

      const imageUrl = (hovered.el.tagName === 'IMG'
        ? pickHttpImageUrlFromImg(hovered.el)
        : pickHttpBgUrl(hovered.el)) || hovered.url

      if (!imageUrl || !isHttpUrl(imageUrl)) {
        btn.dataset.state = 'err'
        btn.textContent = '!'
        showToast('Ova slika se ne može sačuvati (nije obična http(s) slika).', false)
        setTimeout(() => { btn.dataset.state = 'idle'; btn.textContent = '+' }, 1400)
        return
      }

      btn.dataset.state = 'busy'
      btn.textContent = '…'

      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        btn.dataset.state = 'err'
        btn.textContent = '!'
        showToast('Greška pri čuvanju slike.', false)
        setTimeout(() => { btn.dataset.state = 'idle'; btn.textContent = '+' }, 1400)
        return
      }

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
  }

  function collectPageImageUrls() {
    const seen = new Set()
    const urls = []
    const add = url => {
      if (url && !seen.has(url)) {
        seen.add(url)
        urls.push(url)
      }
    }

    document.querySelectorAll('img').forEach(img => {
      if (!isLargeEnough(img)) return
      add(pickHttpImageUrlFromImg(img))
    })
    document.querySelectorAll('picture').forEach(pic => {
      if (pic.querySelector('img')) return
      if (!isLargeEnough(pic)) return
      add(pickHttpImageUrlFromPicture(pic))
    })
    document.querySelectorAll('[style*="background"]').forEach(el => {
      if (!isLargeEnough(el)) return
      for (const url of extractCssBgUrls(el.getAttribute('style') || '')) add(url)
    })

    // If the page painted everything via CSS (no eligible <img>), walk large
    // boxes once. ponytail: O(n) computed-style scan, only on the empty-img path.
    if (!urls.length && document.body) {
      const all = document.body.getElementsByTagName('*')
      for (const el of all) {
        if (!isLargeEnough(el)) continue
        add(pickHttpBgUrl(el))
      }
    }
    return urls
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'XM_PING') {
        sendResponse({ ok: true })
        return
      }

      if (msg?.type === 'XM_CLIP_RESULT') {
        if (msg.ok) showToast(msg.alreadySaved ? 'Već sačuvano u XXmachine.' : 'Sačuvano u XXmachine.', true)
        else showToast(msg.error || 'Greška pri čuvanju slike.', false)
        return
      }

      if (msg?.type === 'XM_SCAN_PAGE_IMAGES') {
        sendResponse({ urls: collectPageImageUrls() })
        return
      }
    })
  }
}

function mountHost() {
  const existing = document.querySelector('[data-xm-clipper]')
  if (existing) return existing
  const host = document.createElement('div')
  host.setAttribute('data-xm-clipper', '')
  host.style.all = 'initial'
  host.style.pointerEvents = 'none'
  try {
    document.documentElement.appendChild(host)
    return host
  } catch {
    try {
      if (!document.body) return null
      document.body.appendChild(host)
      return host
    } catch {
      return null
    }
  }
}

function attachOverlay(host) {
  let shadow
  try {
    if (host.shadowRoot) shadow = host.shadowRoot
    else {
      // Open shadow when not running as an installed extension so a fixture
      // page can assert on the button. Real installs have chrome.runtime.id.
      const mode = typeof chrome !== 'undefined' && chrome.runtime?.id ? 'closed' : 'open'
      shadow = host.attachShadow({ mode })
    }
  } catch {
    return null
  }

  if (!shadow.querySelector('style')) {
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
        pointer-events: auto;
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
        pointer-events: none;
      }
      .xm-toast[data-ok="false"] { background: #7f1d1d; }
      .xm-toast.show { opacity: 1; transform: translateY(0); }
    `
    shadow.appendChild(style)
  }

  let btn = shadow.querySelector('.xm-btn')
  if (!btn) {
    btn = document.createElement('button')
    btn.className = 'xm-btn'
    btn.type = 'button'
    btn.title = 'Sačuvaj u XXmachine'
    btn.textContent = '+'
    btn.style.display = 'none'
    shadow.appendChild(btn)
  }

  let toastEl = shadow.querySelector('.xm-toast')
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.className = 'xm-toast'
    shadow.appendChild(toastEl)
  }

  return { btn, toastEl }
}
