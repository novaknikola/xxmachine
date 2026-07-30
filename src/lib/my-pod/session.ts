import { one, query, rows } from '@/lib/db'
import { encryptSecret, decryptSecret, MY_POD_SECRET_PURPOSE } from '@/lib/secret-crypto'
import { normalizeComfyUrl, maskHost, probeComfyHealth, RUNPOD_SSH_HOST_RE } from '@/lib/my-pod/comfy'
import { parseRunpodSshCommand } from '@/lib/my-pod/parse-ssh'
import { resolvePlatformSshPrivateKey } from '@/lib/my-pod/platform-ssh-key'
import { probeSsh, ensureRemoteWorkDir, type SshAuth } from '@/lib/my-pod/ssh'

const SESSION_TTL_HOURS = 24
const DEFAULT_WORK_ROOT = '/workspace/xxmachine'

export type PodWorkflowKey = 'talk' | 'animate' | 'i2v'

export interface PodSessionPublic {
  id: string
  name: string
  connected: boolean
  healthy: boolean
  comfyBaseUrl: string | null
  sshHostMasked: string | null
  sshPort: number | null
  sshUser: string | null
  remoteWorkRoot: string | null
  hasFishApiKey: boolean
  lastOkAt: string | null
  lastError: string | null
  expiresAt: string | null
}

export interface PodWorkflowDefaultsPublic {
  talkSessionId: string | null
  animateSessionId: string | null
  i2vSessionId: string | null
}

export interface PodSessionSecrets {
  id: string
  name: string
  comfyBaseUrl: string
  ssh: SshAuth
  comfyApiToken: string | null
  fishApiKey: string | null
  remoteWorkRoot: string
  expiresAt: Date
}

interface PodSessionRow {
  id: string
  user_id: string
  name: string
  comfy_base_url: string
  ssh_host: string
  ssh_port: number
  ssh_user: string
  ssh_auth_type: 'password' | 'private_key'
  ssh_auth_enc: string
  comfy_api_token_enc: string | null
  fish_api_key_enc: string | null
  remote_work_root: string
  last_ok_at: Date | null
  last_error: string | null
  expires_at: Date
}

/** Only what the user pastes in My Pod → Connection. */
export interface SavePodSessionInput {
  /** Existing session id to update; omit to create. */
  id?: string
  name?: string
  comfyBaseUrl: string
  sshCommand: string
  /** Fish Audio API key. Blank keeps existing saved key. */
  fishApiKey?: string
}

function rowToSecrets(row: PodSessionRow): PodSessionSecrets {
  const secret = resolvePlatformSshPrivateKey()
  return {
    id: row.id,
    name: row.name,
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
    fishApiKey: row.fish_api_key_enc
      ? decryptSecret(row.fish_api_key_enc, MY_POD_SECRET_PURPOSE)
      : null,
    remoteWorkRoot: row.remote_work_root,
    expiresAt: new Date(row.expires_at),
  }
}

export function toPublic(row: PodSessionRow | null, healthyOverride?: boolean): PodSessionPublic {
  if (!row) {
    return {
      id: '',
      name: '',
      connected: false,
      healthy: false,
      comfyBaseUrl: null,
      sshHostMasked: null,
      sshPort: null,
      sshUser: null,
      remoteWorkRoot: null,
      hasFishApiKey: false,
      lastOkAt: null,
      lastError: null,
      expiresAt: null,
    }
  }
  const expired = new Date(row.expires_at).getTime() < Date.now()
  const healthy = healthyOverride ?? (!!row.last_ok_at && !row.last_error && !expired)
  return {
    id: row.id,
    name: row.name,
    connected: true,
    healthy: healthy && !expired,
    comfyBaseUrl: row.comfy_base_url,
    sshHostMasked: maskHost(row.ssh_host),
    sshPort: row.ssh_port,
    sshUser: row.ssh_user,
    remoteWorkRoot: row.remote_work_root,
    hasFishApiKey: !!row.fish_api_key_enc,
    lastOkAt: row.last_ok_at ? new Date(row.last_ok_at).toISOString() : null,
    lastError: row.last_error,
    expiresAt: new Date(row.expires_at).toISOString(),
  }
}

function sanitizeName(raw: string | undefined, fallback: string): string {
  const n = (raw ?? '').trim().slice(0, 64)
  return n || fallback
}

export async function listPodSessionRows(userId: string): Promise<PodSessionRow[]> {
  return rows<PodSessionRow>(
    `SELECT * FROM pod_sessions WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  )
}

export async function getPodSessionRowById(
  userId: string,
  sessionId: string,
): Promise<PodSessionRow | null> {
  return one<PodSessionRow>(
    `SELECT * FROM pod_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  )
}

/** Legacy helper: first session for user (oldest). */
export async function getPodSessionRow(userId: string): Promise<PodSessionRow | null> {
  const list = await listPodSessionRows(userId)
  return list[0] ?? null
}

export async function listPodSessions(userId: string): Promise<PodSessionPublic[]> {
  const list = await listPodSessionRows(userId)
  return list.map(r => toPublic(r))
}

export async function getPodSessionPublic(userId: string): Promise<PodSessionPublic> {
  const row = await getPodSessionRow(userId)
  return toPublic(row)
}

export async function getWorkflowDefaults(userId: string): Promise<PodWorkflowDefaultsPublic> {
  const row = await one<{
    default_talk_session_id: string | null
    default_animate_session_id: string | null
    default_i2v_session_id: string | null
  }>(
    `SELECT default_talk_session_id, default_animate_session_id, default_i2v_session_id
       FROM pod_workflow_defaults WHERE user_id = $1`,
    [userId],
  )
  return {
    talkSessionId: row?.default_talk_session_id ?? null,
    animateSessionId: row?.default_animate_session_id ?? null,
    i2vSessionId: row?.default_i2v_session_id ?? null,
  }
}

export async function setWorkflowDefault(
  userId: string,
  workflow: PodWorkflowKey,
  sessionId: string | null,
): Promise<PodWorkflowDefaultsPublic> {
  if (sessionId) {
    const owned = await getPodSessionRowById(userId, sessionId)
    if (!owned) throw new Error('Pod not found')
  }
  const col =
    workflow === 'talk'
      ? 'default_talk_session_id'
      : workflow === 'animate'
        ? 'default_animate_session_id'
        : 'default_i2v_session_id'

  await query(
    `INSERT INTO pod_workflow_defaults (user_id, ${col}, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET
       ${col} = EXCLUDED.${col},
       updated_at = now()`,
    [userId, sessionId],
  )
  return getWorkflowDefaults(userId)
}

/** Resolve which pod to use for a workflow submit. */
export async function resolvePodSessionId(
  userId: string,
  workflow: PodWorkflowKey,
  preferredId?: string | null,
): Promise<string> {
  if (preferredId?.trim()) {
    const row = await getPodSessionRowById(userId, preferredId.trim())
    if (!row) throw new Error('Selected pod not found — reconnect in My Pod → Connection')
    return row.id
  }
  const defaults = await getWorkflowDefaults(userId)
  const fromDefault =
    workflow === 'talk'
      ? defaults.talkSessionId
      : workflow === 'animate'
        ? defaults.animateSessionId
        : defaults.i2vSessionId
  if (fromDefault) {
    const row = await getPodSessionRowById(userId, fromDefault)
    if (row) return row.id
  }
  const list = await listPodSessionRows(userId)
  if (list.length === 1) return list[0].id
  if (list.length === 0) throw new Error('Pod offline — connect SSH + ComfyUI URL in My Pod → Connection')
  throw new Error('Select which pod to use — you have multiple pods connected')
}

/** Returns decrypted secrets if session exists and is not expired. */
export async function getPodSessionSecrets(
  userId: string,
  sessionId?: string | null,
): Promise<PodSessionSecrets | null> {
  let row: PodSessionRow | null = null
  if (sessionId) {
    row = await getPodSessionRowById(userId, sessionId)
  } else {
    // Legacy jobs: prefer sole session, else most recently updated.
    const list = await listPodSessionRows(userId)
    if (list.length === 1) row = list[0]
    else if (list.length > 1) {
      row = [...list].sort(
        (a, b) => new Date(b.expires_at).getTime() - new Date(a.expires_at).getTime(),
      )[0] ?? null
    }
  }
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
  const comfy = await probeComfyHealth(input.comfyBaseUrl, input.comfyApiToken)
  if (!comfy.ok) return { ok: false, error: comfy.error }

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
  const sshAuthEnc = encryptSecret('platform', MY_POD_SECRET_PURPOSE)

  let existing: PodSessionRow | null = null
  if (input.id?.trim()) {
    existing = await getPodSessionRowById(userId, input.id.trim())
    if (!existing) throw new Error('Pod not found')
  }

  const name = sanitizeName(input.name, existing?.name || 'Default')

  const fishIncoming = input.fishApiKey?.trim() ?? ''
  let fishEnc: string | null
  if (fishIncoming) {
    fishEnc = encryptSecret(fishIncoming, MY_POD_SECRET_PURPOSE)
  } else if (existing?.fish_api_key_enc) {
    fishEnc = existing.fish_api_key_enc
  } else {
    fishEnc = null
  }

  if (existing) {
    await query(
      `UPDATE pod_sessions SET
         name = $2,
         comfy_base_url = $3,
         ssh_host = $4,
         ssh_port = $5,
         ssh_user = $6,
         ssh_auth_type = 'private_key',
         ssh_auth_enc = $7,
         comfy_api_token_enc = NULL,
         fish_api_key_enc = $8,
         remote_work_root = $9,
         last_ok_at = now(),
         last_error = NULL,
         expires_at = $10,
         updated_at = now()
       WHERE id = $1 AND user_id = $11`,
      [
        existing.id, name, comfyBaseUrl, sshHost, sshPort, sshUser, sshAuthEnc,
        fishEnc, remoteWorkRoot, expiresAt.toISOString(), userId,
      ],
    )
    return toPublic(await getPodSessionRowById(userId, existing.id), true)
  }

  // Unique name: if taken, append short suffix
  let finalName = name
  const clash = await one<{ id: string }>(
    `SELECT id FROM pod_sessions WHERE user_id = $1 AND name = $2`,
    [userId, finalName],
  )
  if (clash) {
    finalName = sanitizeName(`${name} ${Date.now().toString(36).slice(-4)}`, 'Pod')
  }

  const inserted = await one<{ id: string }>(
    `INSERT INTO pod_sessions (
       user_id, name, comfy_base_url, ssh_host, ssh_port, ssh_user, ssh_auth_type, ssh_auth_enc,
       comfy_api_token_enc, fish_api_key_enc, remote_work_root, last_ok_at, last_error, expires_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'private_key',$7,NULL,$8,$9, now(), NULL, $10, now())
     RETURNING id`,
    [
      userId, finalName, comfyBaseUrl, sshHost, sshPort, sshUser, sshAuthEnc,
      fishEnc, remoteWorkRoot, expiresAt.toISOString(),
    ],
  )
  return toPublic(await getPodSessionRowById(userId, inserted!.id), true)
}

export async function testPodSession(
  userId: string,
  sessionId?: string | null,
): Promise<PodSessionPublic> {
  const row = sessionId
    ? await getPodSessionRowById(userId, sessionId)
    : await getPodSessionRow(userId)
  if (!row) throw new Error('No pod session saved — connect first')
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE id = $1`,
      [row.id, 'Session expired — reconnect with SSH + ComfyUI URL'],
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
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE id = $1`,
      [row.id, probe.error],
    )
    throw new Error(probe.error)
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000)
  await query(
    `UPDATE pod_sessions
        SET last_ok_at = now(), last_error = NULL, expires_at = $2, updated_at = now()
      WHERE id = $1`,
    [row.id, expiresAt.toISOString()],
  )
  return toPublic(await getPodSessionRowById(userId, row.id), true)
}

/** Lightweight health for cron: HTTP first, SSH only if HTTP fails. */
export async function refreshPodSessionHealth(
  userId: string,
  sessionId?: string | null,
): Promise<void> {
  const row = sessionId
    ? await getPodSessionRowById(userId, sessionId)
    : await getPodSessionRow(userId)
  if (!row) return
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE id = $1`,
      [row.id, 'Session expired'],
    )
    return
  }

  let secrets: PodSessionSecrets
  try {
    secrets = rowToSecrets(row)
  } catch {
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE id = $1`,
      [row.id, 'Decrypt failed'],
    )
    return
  }

  const comfy = await probeComfyHealth(secrets.comfyBaseUrl, secrets.comfyApiToken, 45_000)
  if (comfy.ok) {
    await query(
      `UPDATE pod_sessions SET last_ok_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
      [row.id],
    )
    return
  }

  const ssh = await probeSsh(secrets.ssh)
  if (ssh.ok) {
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE id = $1`,
      [row.id, `ComfyUI down (SSH ok): ${comfy.error}`],
    )
    return
  }

  await query(
    `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE id = $1`,
    [row.id, `Pod offline — ${comfy.error}; SSH: ${ssh.error}`],
  )
}

export async function deletePodSession(userId: string, sessionId?: string | null): Promise<void> {
  if (sessionId?.trim()) {
    await query(`DELETE FROM pod_sessions WHERE id = $1 AND user_id = $2`, [sessionId.trim(), userId])
    return
  }
  // Legacy: delete all pods for user
  await query(`DELETE FROM pod_sessions WHERE user_id = $1`, [userId])
}

/** Require a healthy non-expired session for job submit. */
export async function requireHealthyPodSession(
  userId: string,
  sessionId?: string | null,
): Promise<PodSessionSecrets> {
  const secrets = await getPodSessionSecrets(userId, sessionId)
  if (!secrets) throw new Error('Pod offline — connect SSH + ComfyUI URL in My Pod → Connection')

  const comfy = await probeComfyHealth(secrets.comfyBaseUrl, secrets.comfyApiToken, 45_000)
  if (!comfy.ok) {
    await query(
      `UPDATE pod_sessions SET last_error = $2, updated_at = now() WHERE id = $1`,
      [secrets.id, comfy.error],
    )
    throw new Error(`Pod offline — ${comfy.error}. Test connection in My Pod.`)
  }
  return secrets
}
