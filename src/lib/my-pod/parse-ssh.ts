/** Client-safe helpers for RunPod Connect tab strings. */

export const RUNPOD_COMFY_URL_RE = /^https:\/\/[a-z0-9-]+-\d+\.proxy\.runpod\.net\/?$/i
export const RUNPOD_SSH_HOST_RE = /^([a-z0-9.-]+\.proxy\.runpod\.net|ssh\.runpod\.io)$/i

/** Parse `ssh user@host -i key` (RunPod Connect tab) into form fields. */
export function parseRunpodSshCommand(cmd: string): {
  sshHost: string
  sshPort: number
  sshUser: string
} | null {
  const m = cmd.trim().match(
    /^ssh\s+(?:-p\s+(\d+)\s+)?([^\s@]+)@([^\s]+)/i,
  )
  if (!m) return null
  return {
    sshPort: m[1] ? Number(m[1]) : 22,
    sshUser: m[2],
    sshHost: m[3],
  }
}

export function normalizeComfyUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!RUNPOD_COMFY_URL_RE.test(trimmed)) {
    throw new Error('ComfyUI URL must look like https://<pod-id>-8188.proxy.runpod.net')
  }
  return trimmed
}

export function maskHost(host: string): string {
  if (host.length <= 12) return host
  return `${host.slice(0, 6)}…${host.slice(-8)}`
}
