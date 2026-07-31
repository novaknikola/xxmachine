import { Client, type ConnectConfig, type ExecOptions } from 'ssh2'

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
    readyTimeout: 90_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 6,
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

function isPtyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /PTY|pseudo-?tty|pseudo-terminal/i.test(msg)
}

function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /timed out|Timeout|ECONNRESET|ECONNREFUSED|Hang up|Socket closed/i.test(msg)
}

/**
 * Run a remote command. RunPod ssh.runpod.io needs a PTY and is slow —
 * timer starts only after the connection is ready; timeouts retry.
 */
export async function sshExec(
  auth: SshAuth,
  command: string,
  timeoutMs = 90_000,
  retries = 3,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const needsWrap = command.includes('\n') || command.length > 400
  const remote = needsWrap
    ? `echo ${Buffer.from(command, 'utf8').toString('base64')} | base64 -d | bash`
    : command

  const tryOnce = (opts: ExecOptions | undefined) =>
    withSsh(auth, client =>
      new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
        // Timer starts after connect — connect has its own readyTimeout.
        const timer = setTimeout(() => reject(new Error('SSH command timed out')), timeoutMs)
        const onErr = (err: Error) => {
          clearTimeout(timer)
          reject(err)
        }
        const cb = (err: Error | undefined, stream: import('ssh2').Channel) => {
          if (err) {
            onErr(err)
            return
          }
          let stdout = ''
          let stderr = ''
          stream
            .on('close', (code: number) => {
              clearTimeout(timer)
              resolve({ stdout, stderr, code: code ?? 0 })
            })
            .on('error', onErr)
            .on('data', (d: Buffer) => { stdout += d.toString() })
          stream.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        }
        if (opts) client.exec(remote, opts, cb)
        else client.exec(remote, cb)
      }),
    )

  const withPty: ExecOptions = {
    pty: { term: 'xterm-256color', cols: 120, rows: 30 },
  }

  let lastErr: unknown
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await tryOnce(withPty)
      if (result.code !== 0 && isPtyError(result.stderr || result.stdout)) {
        return await tryOnce(undefined)
      }
      return result
    } catch (err) {
      lastErr = err
      if (isPtyError(err)) {
        try {
          return await tryOnce(undefined)
        } catch (err2) {
          lastErr = err2
        }
      }
      if (!isTimeoutError(err) && !isPtyError(err) && attempt === retries) break
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2_000 * attempt))
        continue
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export async function probeSsh(auth: SshAuth): Promise<{ ok: true; uname: string } | { ok: false; error: string }> {
  try {
    const { stdout, code, stderr } = await sshExec(auth, 'echo ok && uname -a', 60_000)
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

  const { stdout, code, stderr } = await sshExec(auth, script, 90_000)
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
  await sshExec(auth, `rm -rf ${JSON.stringify(safe)}`, 90_000).catch(() => {})
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
