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

const bulkStatus = document.getElementById('bulkStatus')
function setBulkStatus(text, state) {
  bulkStatus.textContent = text
  bulkStatus.className = state ? state : ''
}

document.getElementById('grabAll').addEventListener('click', async () => {
  const btn = document.getElementById('grabAll')
  const folder = document.getElementById('folderName').value.trim()

  btn.disabled = true
  setBulkStatus('Skeniram stranicu…')
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) throw new Error('Nema aktivnog taba.')

    let scan
    try {
      scan = await chrome.tabs.sendMessage(tab.id, { type: 'XM_SCAN_PAGE_IMAGES' })
    } catch {
      throw new Error('Stranica nije spremna — osveži je (F5) pa probaj ponovo.')
    }
    let urls = scan?.urls || []
    if (!urls.length) throw new Error('Nema slika na ovoj stranici koje mogu da se sačuvaju.')
    const truncated = urls.length > 200
    if (truncated) urls = urls.slice(0, 200)

    setBulkStatus(`Čuvam ${urls.length} slika${truncated ? ' (ograničeno na 200)' : ''}…`)
    const result = await chrome.runtime.sendMessage({
      type: 'XM_CLIP_BULK',
      imageUrls: urls,
      folder,
      pageUrl: tab.url || '',
      title: tab.title || '',
    })

    if (!result?.ok) {
      setBulkStatus(result?.error || 'Greška pri čuvanju.', 'err')
    } else {
      const parts = [`${result.saved} novih`]
      if (result.alreadySaved) parts.push(`${result.alreadySaved} već sačuvano`)
      setBulkStatus(`Gotovo — ${parts.join(', ')}${folder ? ` u "${folder}"` : ''}.`, 'ok')
    }
  } catch (err) {
    setBulkStatus(err instanceof Error ? err.message : 'Greška.', 'err')
  } finally {
    btn.disabled = false
  }
})
