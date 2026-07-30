import { Client, type ConnectConfig } from 'ssh2'

export interface SshAuth {
  host: string
  port: number
  username: string
  authType: 'password' | 'private_key'
  secret: string
}

function connectConfig(auth: SshAuth): ConnectConfig {
  const base: ConnectConfig = {
    host: auth.host,
    port: auth.port,
    username: auth.username,
    readyTimeout: 30_000,
    // RunPod proxy can be flaky on first connect
    tryKeyboard: false,
  }
  if (auth.authType === 'password') {
    return { ...base, password: auth.secret }
  }
  return { ...base, privateKey: auth.secret }
}

export async function withSsh<T>(auth: SshAuth, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client()
  try {
    await new Promise<void>((resolve, reject) => {
      client
        .on('ready', () => resolve())
        .on('error', reject)
        .connect(connectConfig(auth))
    })
    return await fn(client)
  } finally {
    client.end()
  }
}

export async function sshExec(auth: SshAuth, command: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return withSsh(auth, client =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSH command timed out')), timeoutMs)
      client.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          reject(err)
          return
        }
        let stdout = ''
        let stderr = ''
        stream
          .on('close', (code: number) => {
            clearTimeout(timer)
            resolve({ stdout, stderr, code: code ?? 0 })
          })
          .on('data', (d: Buffer) => { stdout += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      })
    }),
  )
}

export async function probeSsh(auth: SshAuth): Promise<{ ok: true; uname: string } | { ok: false; error: string }> {
  try {
    const { stdout, code, stderr } = await sshExec(auth, 'echo ok && uname -a', 30_000)
    if (code !== 0) return { ok: false, error: stderr.trim() || `SSH exit ${code}` }
    if (!stdout.includes('ok')) return { ok: false, error: 'SSH probe failed unexpectedly' }
    return { ok: true, uname: stdout.replace(/^ok\s*/i, '').trim() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Ensure remote work dir exists and has >= minFreeGb free space. */
export async function ensureRemoteWorkDir(
  auth: SshAuth,
  remoteWorkRoot: string,
  jobId?: string,
  minFreeGb = 5,
): Promise<{ remoteJobDir: string }> {
  const root = remoteWorkRoot.replace(/\/+$/, '') || '/workspace/xxmachine'
  const remoteJobDir = jobId ? `${root}/${jobId}` : root
  const script = [
    `mkdir -p ${JSON.stringify(remoteJobDir)}`,
    `df -BG --output=avail ${JSON.stringify(root)} 2>/dev/null | tail -1 | tr -dc '0-9' || df -m ${JSON.stringify(root)} | tail -1 | awk '{print int($4/1024)}'`,
  ].join(' && ')

  const { stdout, code, stderr } = await sshExec(auth, script, 60_000)
  if (code !== 0) throw new Error(`SSH mkdir failed: ${stderr.trim() || `exit ${code}`}`)

  const freeGb = Number.parseInt(stdout.trim().split('\n').pop() ?? '', 10)
  if (Number.isFinite(freeGb) && freeGb < minFreeGb) {
    throw new Error(`Pod disk low: ~${freeGb}GB free (need ≥${minFreeGb}GB)`)
  }
  return { remoteJobDir }
}

export async function cleanupRemoteJobDir(auth: SshAuth, remoteJobDir: string): Promise<void> {
  const safe = remoteJobDir.replace(/\/+$/, '')
  if (!safe || safe === '/' || safe.length < 10) return
  await sshExec(auth, `rm -rf ${JSON.stringify(safe)}`, 60_000).catch(() => {})
}

/** Upload a buffer to a remote path via SFTP. */
export async function sftpUpload(auth: SshAuth, remotePath: string, buffer: Buffer): Promise<void> {
  await withSsh(auth, client =>
    new Promise<void>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err)
        const dir = remotePath.replace(/\/[^/]+$/, '')
        const mkdirCmd = `mkdir -p ${JSON.stringify(dir)}`
        client.exec(mkdirCmd, (e2, stream) => {
          if (e2) return reject(e2)
          stream.on('close', () => {
            const ws = sftp.createWriteStream(remotePath)
            ws.on('close', () => resolve())
            ws.on('error', reject)
            ws.end(buffer)
          })
          stream.resume()
        })
      })
    }),
  )
}
