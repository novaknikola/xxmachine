import { one, query } from '@/lib/db'
import { encryptSecret, decryptSecret, MY_POD_SECRET_PURPOSE } from '@/lib/secret-crypto'
import { normalizeComfyUrl, maskHost, probeComfyHealth, RUNPOD_SSH_HOST_RE } from '@/lib/my-pod/comfy'
import { parseRunpodSshCommand } from '@/lib/my-pod/parse-ssh'
import { resolvePlatformSshPrivateKey } from '@/lib/my-pod/platform-ssh-key'
import { probeSsh, ensureRemoteWorkDir, type SshAuth } from '@/lib/my-pod/ssh'

const SESSION_TTL_HOURS = 24
const DEFAULT_WORK_ROOT = '/workspace/xxmachine'

export interface PodSessionPublic {
  connected: boolean
  healthy: boolean
  comfyBaseUrl: string | null
  sshHostMasked: string | null
  sshPort: number | null
  sshUser: string | null
  remoteWorkRoot: string | null
  lastOkAt: string | null
  lastError: string | null
  expiresAt: string | null
}

export interface PodSessionSecrets {
  comfyBaseUrl: string
  ssh: SshAuth
  comfyApiToken: string | null
  remoteWorkRoot: string
  expiresAt: Date
}

interface PodSessionRow {
  user_id: string
  comfy_base_url: string
  ssh_host: string
  ssh_port: number
  ssh_user: string
  ssh_auth_type: 'password' | 'private_key'
  ssh_auth_enc: string
  comfy_api_token_enc: string | null
  remote_work_root: string
  last_ok_at: Date | null
  last_error: string | null
  expires_at: Date
}

/** Only what the user pastes from RunPod Connect. */
export interface SavePodSessionInput {
  comfyBaseUrl: string
  sshCommand: string
}

function rowToSecrets(row: PodSessionRow): PodSessionSecrets {
  // Always use the VPS platform key — user never pastes a key in the UI.
  const secret = resolvePlatformSshPrivateKey()
  return {
    comfyBaseUrl: row.comfy_base_url.replace(/\/+$/, ''),
    ssh: {
      host: row.ssh_host,
      port: row.ssh_port,
      username: row.ssh_user,
      authType: 'private_key',
      secret,
    },
    comfyApiToken: row.comfy_api_token_enc
      ? decryptSecret(row.comfy_api_token_enc, MY_POD_SECRET_PURPOSE)
      : null,
    remoteWorkRoot: row.remote_work_root,
    expiresAt: new Date(row.expires_at),
  }
}

export function toPublic(row: PodSessionRow | null, healthyOverride?: boolean): PodSessionPublic {
  if (!row) {
    return {
      connected: false,
      healthy: false,
      comfyBaseUrl: null,
      sshHostMasked: null,
      sshPort: null,
      sshUser: null,
      remoteWorkRoot: null,
      lastOkAt: null,
      lastError: null,
      expiresAt: null,
    }
  }
  const expired = new Date(row.expires_at).getTime() < Date.now()
  const healthy = healthyOverride ?? (!!row.last_ok_at && !row.last_error && !expired)
  return {
    connected: true,
    healthy: healthy && !expired,
    comfyBaseUrl: row.comfy_base_url,
    sshHostMasked: maskHost(row.ssh_host),
    sshPort: row.ssh_port,
    sshUser: row.ssh_user,
    remoteWorkRoot: row.remote_work_root,
    lastOkAt: row.last_ok_at ? new Date(row.last_ok_at).toISOString() : null,
    lastError: row.last_error,
    expiresAt: new Date(row.expires_at).toISOString(),
  }
}

export async function getPodSessionRow(userId: string): Promise<PodSessionRow | null> {
  return one<PodSessionRow>(`SELECT * FROM pod_sessions WHERE user_id = $1`, [userId])
}

export async function getPodSessionPublic(userId: string): Promise<PodSessionPublic> {
  const row = await getPodSessionRow(userId)
  return toPublic(row)
}

/** Returns decrypted secrets if session exists and is not expired. */
export async function getPodSessionSecrets(userId: string): Promise<PodSessionSecrets | null> {
  const row = await getPodSessionRow(userId)
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  try {
    return rowToSecrets(row)
  } catch {
    return null
  }
}

export async function validatePodConnection(input: {
  comfyBaseUrl: string
  sshHost: string
  sshPort: number
  sshUser: string
  sshAuthType: 'password' | 'private_key'
  sshSecret: string
  comfyApiToken?: string | null
  remoteWorkRoot: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Comfy HTTP is required for all job I/O (RunPod SSH has no SFTP).
  const comfy = await probeComfyHealth(input.comfyBaseUrl, input.comfyApiToken)
  if (!comfy.ok) return { ok: false, error: comfy.error }

  // SSH is best-effort (shell probe / mkdir). RunPod gateway often rejects PTY;
  // do not block Connect if Comfy is healthy.
  const ssh = await probeSsh({
    host: input.sshHost,
    port: input.sshPort,
    username: input.sshUser,
    authType: input.sshAuthType,
    secret: input.sshSecret,
  })
  if (!ssh.ok) {
    console.warn('[my-pod] SSH probe soft-fail (Comfy OK):', ssh.error)
  } else {
    try {
      await ensureRemoteWorkDir(
        {
          host: input.sshHost,
          port: input.sshPort,
          username: input.sshUser,
          authType: input.sshAuthType,
          secret: input.sshSecret,
        },
        input.remoteWorkRoot,
      )
    } catch (err) {
      console.warn('[my-pod] remote work dir check:', err instanceof Error ? err.message : err)
    }
  }

  return { ok: true }
}

export async function savePodSession(
  userId: string,
  input: SavePodSessionInput,
): Promise<PodSessionPublic> {
  const comfyBaseUrl = normalizeComfyUrl(input.comfyBaseUrl)
  const parsed = parseRunpodSshCommand(input.sshCommand ?? '')
  if (!parsed) {
    throw new Error(
      'Paste the full SSH line from RunPod Connect, e.g. ssh user@ssh.runpod.io -i ~/.ssh/id_ed25519',
    )
  }
  const sshHost = parsed.sshHost.trim().toLowerCase()
  if (!RUNPOD_SSH_HOST_RE.test(sshHost) && !/^[a-z0-9.-]+$/i.test(sshHost)) {
    throw new Error('Invalid SSH host in command')
  }
  const sshPort = parsed.sshPort > 0 ? parsed.sshPort : 22
  const sshUser = parsed.sshUser.trim()
  if (!sshUser) throw new Error('SSH user missing from command')

  const sshSecret = resolvePlatformSshPrivateKey()
  const remoteWorkRoot = DEFAULT_WORK_ROOT

  const probe = await validatePodConnection({
    comfyBaseUrl,
    sshHost,
    sshPort,
    sshUser,
    sshAuthType: 'private_key',
    sshSecret,
    comfyApiToken: null,
    remoteWorkRoot,
  })
  if (!probe.ok) throw new Error(probe.error)

  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000)
  // Placeholder only — runtime always uses resolvePlatformSshPrivateKey()
  const sshAuthEnc = encryptSecret('platform', MY_POD_SECRET_PURPOSE)

  await query(
    `INSERT INTO pod_sessions (
       user_id, comfy_base_url, ssh_host, ssh_port, ssh_user, ssh_auth_type, ssh_auth_enc,
       comfy_api_token_enc, remote_work_root, last_ok_at, last_error, expires_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'private_key',$6,NULL,$7, now(), NULL, $8, now())
     ON CONFLICT (user_id) DO UPDATE SET
       comfy_base_url = EXCLUDED.comfy_base_url,
       ssh_host = EXCLUDED.ssh_host,
       ssh_port = EXCLUDED.ssh_port,
       ssh_user = EXCLUDED.ssh_user,
       ssh_auth_type = EXCLUDED.ssh_auth_type,
       ssh_auth_enc = EXCLUDED.ssh_auth_enc,
       comfy_api_token_enc = NULL,
       remote_work_root = EXCLUDED.remote_work_root,
       last_ok_at = now(),
       last_error = NULL,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [
      userId, comfyBaseUrl, sshHost, sshPort, sshUser, sshAuthEnc,
      remoteWorkRoot, expiresAt.toISOString(),
    ],
  )

  const row = await getPodSessionRow(userId)
  return toPublic(row, true)
}

export async function testPodSession(userId: string): Promise<PodSessionPublic> {
  const row = await getPodSessionRow(userId)
  if (!row) throw new Error('No pod session saved — connect first')
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE user_id = $1`,
      [userId, 'Session expired — reconnect with SSH + ComfyUI URL'],
    )
    throw new Error('Session expired — reconnect with SSH + ComfyUI URL')
  }

  let secrets: PodSessionSecrets
  try {
    secrets = rowToSecrets(row)
  } catch {
    throw new Error('Could not decrypt session secrets — reconnect')
  }

  const probe = await validatePodConnection({
    comfyBaseUrl: secrets.comfyBaseUrl,
    sshHost: secrets.ssh.host,
    sshPort: secrets.ssh.port,
    sshUser: secrets.ssh.username,
    sshAuthType: secrets.ssh.authType,
    sshSecret: secrets.ssh.secret,
    comfyApiToken: secrets.comfyApiToken,
    remoteWorkRoot: secrets.remoteWorkRoot,
  })

  if (!probe.ok) {
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE user_id = $1`,
      [userId, probe.error],
    )
    throw new Error(probe.error)
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000)
  await query(
    `UPDATE pod_sessions
        SET last_ok_at = now(), last_error = NULL, expires_at = $2, updated_at = now()
      WHERE user_id = $1`,
    [userId, expiresAt.toISOString()],
  )
  return toPublic(await getPodSessionRow(userId), true)
}

/** Lightweight health for cron: HTTP first, SSH only if HTTP fails. */
export async function refreshPodSessionHealth(userId: string): Promise<void> {
  const row = await getPodSessionRow(userId)
  if (!row) return
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE user_id = $1`,
      [userId, 'Session expired'],
    )
    return
  }

  let secrets: PodSessionSecrets
  try {
    secrets = rowToSecrets(row)
  } catch {
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE user_id = $1`,
      [userId, 'Decrypt failed'],
    )
    return
  }

  const comfy = await probeComfyHealth(secrets.comfyBaseUrl, secrets.comfyApiToken, 10_000)
  if (comfy.ok) {
    await query(
      `UPDATE pod_sessions SET last_ok_at = now(), last_error = NULL, updated_at = now() WHERE user_id = $1`,
      [userId],
    )
    return
  }

  const ssh = await probeSsh(secrets.ssh)
  if (ssh.ok) {
    // SSH up but Comfy down
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE user_id = $1`,
      [userId, `ComfyUI down (SSH ok): ${comfy.error}`],
    )
    return
  }

  await query(
    `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE user_id = $1`,
    [userId, `Pod offline — ${comfy.error}; SSH: ${ssh.error}`],
  )
}

export async function deletePodSession(userId: string): Promise<void> {
  await query(`DELETE FROM pod_sessions WHERE user_id = $1`, [userId])
}

/** Require a healthy non-expired session for job submit. */
export async function requireHealthyPodSession(userId: string): Promise<PodSessionSecrets> {
  const secrets = await getPodSessionSecrets(userId)
  if (!secrets) throw new Error('Pod offline — connect SSH + ComfyUI URL in My Pod → Connection')

  const row = await getPodSessionRow(userId)
  if (row?.last_error) {
    // Allow submit but prefer a fresh probe for generate
  }

  const comfy = await probeComfyHealth(secrets.comfyBaseUrl, secrets.comfyApiToken, 10_000)
  if (!comfy.ok) {
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE user_id = $1`,
      [userId, comfy.error],
    )
    throw new Error(`Pod offline — ${comfy.error}. Test connection in My Pod.`)
  }
  return secrets
}
