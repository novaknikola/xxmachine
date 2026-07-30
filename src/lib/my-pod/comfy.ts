/** RunPod ComfyUI HTTP helpers for My Pod (server-side). */

export {
  RUNPOD_COMFY_URL_RE,
  RUNPOD_SSH_HOST_RE,
  normalizeComfyUrl,
  maskHost,
  parseRunpodSshCommand,
} from '@/lib/my-pod/parse-ssh'

export function comfyHeaders(apiToken?: string | null): HeadersInit {
  const h: Record<string, string> = {
    // RunPod Cloudflare proxy 403s bare Node fetch without a browser-like UA.
    'User-Agent': 'xxmachine-my-pod/1.0',
  }
  if (apiToken) h.Authorization = `Bearer ${apiToken}`
  return h
}

export async function probeComfyHealth(
  comfyBaseUrl: string,
  apiToken?: string | null,
  timeoutMs = 45_000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = comfyBaseUrl.replace(/\/+$/, '')
  // Prefer light endpoints first — /system_stats is often slow through RunPod proxy.
  const paths = ['/queue', '/system_stats', '/', '/object_info']
  const errors: string[] = []

  for (const path of paths) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}${path}`, {
        headers: comfyHeaders(apiToken),
        signal: ctrl.signal,
        redirect: 'follow',
      })
      if (res.ok || (path === '/' && res.status >= 200 && res.status < 500)) {
        return { ok: true }
      }
      errors.push(`${path}→${res.status}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${path}→${msg.includes('abort') ? 'timeout' : msg}`)
    } finally {
      clearTimeout(t)
    }
  }

  return {
    ok: false,
    error: `ComfyUI unreachable (${errors.join('; ')}). Confirm the pod is Running and the comfy URL still works in your browser.`,
  }
}

export interface PodOutputFile {
  filename: string
  subfolder?: string
  type?: string
}

/** Upload any file into ComfyUI input/ via HTTP (images and videos).
 *  Prefer this over SFTP — RunPod SSH gateway often has no SCP/SFTP. */
export async function uploadFileToComfy(
  comfyBaseUrl: string,
  buffer: Buffer,
  filename: string,
  apiToken?: string | null,
): Promise<string> {
  const base = comfyBaseUrl.replace(/\/+$/, '')
  const fd = new FormData()
  fd.append('image', new Blob([new Uint8Array(buffer)]), filename)
  const res = await fetch(`${base}/upload/image`, {
    method: 'POST',
    headers: comfyHeaders(apiToken),
    body: fd,
  })
  const data = await res.json().catch(() => ({})) as { error?: string; name?: string; subfolder?: string }
  if (!res.ok) throw new Error(data.error ?? `Pod upload failed: ${res.status}`)
  return data.subfolder ? `${data.subfolder}/${data.name}` : (data.name as string)
}

export async function uploadImageToComfy(
  comfyBaseUrl: string,
  buffer: Buffer,
  filename: string,
  apiToken?: string | null,
): Promise<string> {
  return uploadFileToComfy(comfyBaseUrl, buffer, filename, apiToken)
}

export async function submitComfyPrompt(
  comfyBaseUrl: string,
  workflow: Record<string, unknown>,
  apiToken?: string | null,
): Promise<string> {
  const base = comfyBaseUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...comfyHeaders(apiToken) },
    body: JSON.stringify({ prompt: workflow }),
  })
  const data = await res.json().catch(() => ({})) as {
    error?: { message?: string } | string
    prompt_id?: string
    node_errors?: unknown
  }
  if (!res.ok) {
    const err = typeof data.error === 'object' ? data.error?.message : data.error
    throw new Error(err ?? `Pod rejected prompt: ${res.status}`)
  }
  if (data.node_errors && Object.keys(data.node_errors as object).length) {
    throw new Error(`Comfy rejected graph: ${JSON.stringify(data.node_errors).slice(0, 500)}`)
  }
  if (!data.prompt_id) throw new Error('No prompt_id returned from pod')
  return data.prompt_id
}

export async function pollComfyResult(
  comfyBaseUrl: string,
  promptId: string,
  opts?: {
    apiToken?: string | null
    maxAttempts?: number
    intervalMs?: number
    preferNodeId?: string
    onHeartbeat?: () => void | Promise<void>
  },
): Promise<PodOutputFile[]> {
  const base = comfyBaseUrl.replace(/\/+$/, '')
  const maxAttempts = opts?.maxAttempts ?? 120
  const interval = opts?.intervalMs ?? 3000
  const token = opts?.apiToken
  let lastBeat = 0

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval))
    if (opts?.onHeartbeat && Date.now() - lastBeat > 60_000) {
      lastBeat = Date.now()
      await opts.onHeartbeat().catch(() => {})
    }
    const res = await fetch(`${base}/history/${promptId}`, {
      headers: comfyHeaders(token),
    }).catch(() => null)
    if (!res?.ok) continue
    const data = await res.json().catch(() => null) as Record<string, {
      status?: { status_str?: string; completed?: boolean }
      outputs?: Record<string, Record<string, unknown>>
    }> | null
    const entry = data?.[promptId]
    if (!entry) continue

    if (entry.status?.status_str === 'error') {
      throw new Error('Pod reported a workflow error — check the ComfyUI console on your pod')
    }

    const outputs = entry.outputs
    if (!outputs || !Object.keys(outputs).length) continue

    if (opts?.preferNodeId && outputs[opts.preferNodeId]) {
      const files = collectOutputFiles(outputs[opts.preferNodeId])
      if (files.length) return files
    }

    const files: PodOutputFile[] = []
    for (const nodeOutput of Object.values(outputs)) {
      files.push(...collectOutputFiles(nodeOutput))
    }
    if (files.length) return files
  }
  throw new Error('Timeout while polling ComfyUI pod result')
}

function collectOutputFiles(nodeOutput: Record<string, unknown>): PodOutputFile[] {
  const files: PodOutputFile[] = []
  for (const key of ['images', 'gifs', 'videos']) {
    const list = nodeOutput[key]
    if (Array.isArray(list)) files.push(...(list as PodOutputFile[]))
  }
  return files
}

export async function downloadFromComfy(
  comfyBaseUrl: string,
  file: PodOutputFile,
  apiToken?: string | null,
): Promise<Buffer> {
  const base = comfyBaseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder ?? '',
    type: file.type ?? 'output',
  })
  const res = await fetch(`${base}/view?${params}`, { headers: comfyHeaders(apiToken) })
  if (!res.ok) throw new Error(`Failed to fetch output from pod: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
