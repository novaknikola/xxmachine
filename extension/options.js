const apiBaseEl = document.getElementById('apiBase')
const tokenEl = document.getElementById('token')
const statusEl = document.getElementById('status')

function setStatus(text, ok) {
  statusEl.textContent = text
  statusEl.className = ok === undefined ? '' : ok ? 'ok' : 'err'
}

chrome.storage.local.get(['apiBase', 'token'], data => {
  if (data.apiBase) apiBaseEl.value = data.apiBase
  if (data.token) tokenEl.value = data.token
})

document.getElementById('save').addEventListener('click', async () => {
  const apiBase = apiBaseEl.value.trim().replace(/\/+$/, '')
  const token = tokenEl.value.trim()
  if (!apiBase || !token) {
    setStatus('Unesi i URL sajta i token.', false)
    return
  }
  await chrome.storage.local.set({ apiBase, token })
  setStatus('Sačuvano.', true)
})

document.getElementById('test').addEventListener('click', async () => {
  const apiBase = apiBaseEl.value.trim().replace(/\/+$/, '')
  const token = tokenEl.value.trim()
  if (!apiBase || !token) {
    setStatus('Unesi i URL sajta i token.', false)
    return
  }
  setStatus('Proveravam…')
  try {
    const res = await fetch(`${apiBase}/api/extension/clip`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.ok) setStatus(`Povezano kao ${data.email}.`, true)
    else setStatus(data.error || `Greška ${res.status}`, false)
  } catch {
    setStatus('Ne mogu da dosegnem taj URL.', false)
  }
})
