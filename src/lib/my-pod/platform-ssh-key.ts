import { existsSync, readFileSync } from 'node:fs'

/**
 * Private key used by xxmachine VPS to SSH into the user's RunPod.
 * Never collected in the UI — only Comfy URL + SSH command are pasted.
 *
 * Resolution order:
 * 1. MY_POD_SSH_PRIVATE_KEY env (full PEM contents)
 * 2. MY_POD_SSH_KEY_PATH file
 * 3. /root/.ssh/runpod_ed25519
 * 4. /root/.ssh/id_ed25519
 */
export function resolvePlatformSshPrivateKey(): string {
  const inline = process.env.MY_POD_SSH_PRIVATE_KEY?.trim()
  if (inline) return inline

  const candidates = [
    process.env.MY_POD_SSH_KEY_PATH?.trim(),
    '/root/.ssh/runpod_ed25519',
    '/root/.ssh/runpod_wan22',
    '/root/.ssh/id_ed25519',
  ].filter((p): p is string => !!p)

  for (const path of candidates) {
    if (existsSync(path)) {
      const body = readFileSync(path, 'utf8').trim()
      if (body.includes('PRIVATE KEY')) return body
    }
  }

  throw new Error(
    'xxmachine server has no RunPod SSH private key. Set MY_POD_SSH_PRIVATE_KEY or install the key at /root/.ssh/id_ed25519 (same key as -i in your RunPod SSH command).',
  )
}
