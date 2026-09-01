const dot = document.getElementById('dot')
const statusText = document.getElementById('statusText')
const countEl = document.getElementById('count')

chrome.storage.local.get(['apiBase', 'token', 'clipCount'], async data => {
  countEl.textContent = data.clipCount ? `Sačuvano slika: ${data.clipCount}` : ''

  if (!data.apiBase || !data.token) {
    dot.className = 'dot err'
    statusText.textContent = 'Nije podešeno'
    return
  }

  try {
    const res = await fetch(`${data.apiBase.replace(/\/+$/, '')}/api/extension/clip`, {
      headers: { Authorization: `Bearer ${data.token}` },
    })
    if (res.ok) {
      dot.className = 'dot ok'
      statusText.textContent = 'Povezano'
    } else {
      dot.className = 'dot err'
      statusText.textContent = 'Token nije važeći'
    }
  } catch {
    dot.className = 'dot err'
    statusText.textContent = 'Server nedostupan'
  }
})

document.getElementById('openOptions').addEventListener('click', e => {
  e.preventDefault()
  chrome.runtime.openOptionsPage()
})
