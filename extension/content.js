// Pinterest-style hover button: hover any <img> on any page, a small button
// appears over its corner, click it to save straight to XXmachine. A
// right-click "Sačuvaj sliku u XXmachine" context menu item (background.js)
// covers images this can't reach (very small ones, sites that block hover).

const MIN_SIZE = 60 // px — skip icons/avatars/tracking pixels

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

function positionButton(img) {
  const rect = img.getBoundingClientRect()
  btn.style.top = `${Math.max(4, rect.top + 6)}px`
  btn.style.left = `${Math.min(window.innerWidth - 38, rect.right - 40)}px`
}

function showButton(img) {
  hoveredImg = img
  btn.dataset.state = 'idle'
  btn.textContent = '+'
  btn.style.display = 'flex'
  positionButton(img)
}

function scheduleHide() {
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    btn.style.display = 'none'
    hoveredImg = null
  }, 180)
}

document.addEventListener('mouseover', e => {
  const img = e.target instanceof Element ? e.target.closest('img') : null
  if (!img || !isEligible(img)) return
  clearTimeout(hideTimer)
  showButton(img)
}, true)

document.addEventListener('mouseout', e => {
  const toEl = e.relatedTarget
  if (toEl === btn) return
  scheduleHide()
}, true)

btn.addEventListener('mouseenter', () => clearTimeout(hideTimer))
btn.addEventListener('mouseleave', scheduleHide)

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

// Feedback for the right-click "Sačuvaj sliku u XXmachine" context menu path.
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'XM_CLIP_RESULT') return
  if (msg.ok) showToast(msg.alreadySaved ? 'Već sačuvano u XXmachine.' : 'Sačuvano u XXmachine.', true)
  else showToast(msg.error || 'Greška pri čuvanju slike.', false)
})
