/**
 * Probe Comfy /object_info for required node types; auto-install missing
 * custom_nodes packs. Works with RunPod ssh.runpod.io + Comfy proxy URL:
 * long work runs in a background shell on the pod; we only use short SSH
 * sessions and poll Comfy over HTTP.
 */
import { comfyHeaders } from '@/lib/my-pod/comfy'
import { sshExec, type SshAuth } from '@/lib/my-pod/ssh'

export interface NodePack {
  provides: string[]
  repo: string
  dir: string
  /** ComfyUI-Manager catalog titles (best-effort HTTP install). */
  managerTitles?: string[]
}

export const ANIMATE_REQUIRED_NODE_TYPES = [
  'DWPreprocessor',
  'WanAnimateToVideo',
  'SaveVideo',
] as const

export const TALK_REQUIRED_NODE_TYPES = [
  'MultiTalkWav2VecEmbeds',
  'WanVideoImageToVideoMultiTalk',
  'WanVideoSampler',
  'VHS_VideoCombine',
  'LoadAudio',
  'LoadImage',
] as const

const ANIMATE_OPTIONAL = ['SDPoseFaceBBoxes', 'CropByBBoxes'] as const

const ANIMATE_PACKS: NodePack[] = [
  {
    provides: ['DWPreprocessor'],
    repo: 'https://github.com/Fannovel16/comfyui_controlnet_aux.git',
    dir: 'comfyui_controlnet_aux',
    managerTitles: [
      "ComfyUI's ControlNet Auxiliary Preprocessors",
      'comfyui_controlnet_aux',
      'ControlNet Auxiliary Preprocessors',
    ],
  },
]

/** kijai wrapper provides InfiniteTalk / MultiTalkWav2VecEmbeds + WanVideo* nodes. */
const TALK_PACKS: NodePack[] = [
  {
    provides: [
      'MultiTalkWav2VecEmbeds',
      'WanVideoImageToVideoMultiTalk',
      'WanVideoSampler',
    ],
    repo: 'https://github.com/kijai/ComfyUI-WanVideoWrapper.git',
    dir: 'ComfyUI-WanVideoWrapper',
    managerTitles: ['ComfyUI-WanVideoWrapper', 'WanVideoWrapper'],
  },
  {
    provides: ['VHS_VideoCombine'],
    repo: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git',
    dir: 'ComfyUI-VideoHelperSuite',
    managerTitles: ['ComfyUI-VideoHelperSuite', 'Video Helper Suite'],
  },
]

async function probeNodeType(
  comfyBaseUrl: string,
  nodeType: string,
  apiToken?: string | null,
  timeoutMs = 25_000,
): Promise<boolean> {
  const base = comfyBaseUrl.replace(/\/+$/, '')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/object_info/${encodeURIComponent(nodeType)}`, {
      headers: comfyHeaders(apiToken),
      signal: ctrl.signal,
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => null) as Record<string, unknown> | null
    return !!(data && data[nodeType])
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

async function probeTypes(
  comfyBaseUrl: string,
  apiToken: string | null | undefined,
  required: readonly string[],
  optional: readonly string[] = [],
): Promise<{ present: string[]; missing: string[]; optionalMissing: string[] }> {
  const present: string[] = []
  const missing: string[] = []
  for (const t of required) {
    if (await probeNodeType(comfyBaseUrl, t, apiToken)) present.push(t)
    else missing.push(t)
  }
  const optionalMissing: string[] = []
  for (const t of optional) {
    if (!(await probeNodeType(comfyBaseUrl, t, apiToken))) optionalMissing.push(t)
  }
  return { present, missing, optionalMissing }
}

async function waitForComfy(
  comfyBaseUrl: string,
  apiToken: string | null | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await probeNodeType(comfyBaseUrl, 'LoadImage', apiToken, 15_000).catch(() => false)
    if (ok) return true
    await new Promise(r => setTimeout(r, 5_000))
  }
  return false
}

function packsForMissing(missing: string[], packs: NodePack[]): NodePack[] {
  return packs.filter(p => p.provides.some(n => missing.includes(n)))
}

async function findComfyRoot(ssh: SshAuth): Promise<string> {
  const { stdout, code } = await sshExec(
    ssh,
    [
      'for d in /workspace/ComfyUI /workspace/RunPod-ComfyUI /workspace/comfyui /ComfyUI /root/ComfyUI; do',
      '  [ -d "$d/custom_nodes" ] && echo "$d" && exit 0',
      'done',
      'ls -d /home/*/ComfyUI/custom_nodes 2>/dev/null | head -1 | sed "s|/custom_nodes||" && exit 0',
      'exit 1',
    ].join('\n'),
    60_000,
  )
  const root = stdout.trim().split('\n').filter(Boolean).pop()
  if (code !== 0 || !root) {
    throw new Error('Could not find ComfyUI/custom_nodes on the pod via SSH.')
  }
  return root
}

/** Best-effort install via ComfyUI-Manager over the public Comfy URL. */
async function tryManagerHttpInstall(
  comfyBaseUrl: string,
  pack: NodePack,
  apiToken?: string | null,
): Promise<boolean> {
  const base = comfyBaseUrl.replace(/\/+$/, '')
  const headers = {
    ...comfyHeaders(apiToken),
    'Content-Type': 'application/json',
  }

  const payloads: unknown[] = [
    {
      install_type: 'git-clone',
      files: [pack.repo],
      title: pack.dir,
      reference: pack.repo,
    },
    pack.repo,
  ]

  const paths = [
    '/customnode/install/git_url',
    '/api/customnode/install/git_url',
    '/customnode/install',
    '/api/customnode/install',
  ]

  for (const path of paths) {
    for (const body of payloads) {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 120_000)
      try {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers,
          body: typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(body),
          signal: ctrl.signal,
        })
        if (res.ok || res.status === 200 || res.status === 201) {
          console.log(`[my-pod] Manager HTTP install accepted via ${path} for ${pack.dir}`)
          return true
        }
      } catch {
        // try next
      } finally {
        clearTimeout(t)
      }
    }
  }
  return false
}

async function restartComfyShort(ssh: SshAuth): Promise<void> {
  await sshExec(
    ssh,
    [
      'set +e',
      'curl -sS -m 8 -X POST http://127.0.0.1:8188/manager/reboot >/dev/null 2>&1 && echo REBOOT_OK && exit 0',
      'pkill -f "python.*main.py" 2>/dev/null || pkill -f "ComfyUI/main.py" 2>/dev/null || true',
      'echo KILLED',
    ].join('\n'),
    45_000,
  ).catch(() => {})
}

/**
 * Start a long git/pip install in the background on the pod, then poll with
 * short SSH checks. This is how RunPod ssh.runpod.io stays usable.
 */
async function installPackBackground(
  ssh: SshAuth,
  root: string,
  pack: NodePack,
  onProgress?: (msg: string) => void | Promise<void>,
): Promise<void> {
  const dest = `${root}/custom_nodes/${pack.dir}`
  const marker = `/tmp/xxm_ok_${pack.dir.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const failMarker = `/tmp/xxm_fail_${pack.dir.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const logFile = `/tmp/xxm_log_${pack.dir.replace(/[^a-zA-Z0-9_-]/g, '_')}.log`

  const work = [
    'set -e',
    `DEST=${JSON.stringify(dest)}`,
    `REPO=${JSON.stringify(pack.repo)}`,
    `ROOT=${JSON.stringify(root)}`,
    `MARKER=${JSON.stringify(marker)}`,
    `FAIL=${JSON.stringify(failMarker)}`,
    'rm -f "$MARKER" "$FAIL"',
    'if [ -d "$DEST/.git" ]; then',
    '  git -C "$DEST" pull --ff-only || true',
    'else',
    '  rm -rf "$DEST"',
    '  git clone --depth 1 "$REPO" "$DEST"',
    'fi',
    'if [ -f "$DEST/requirements.txt" ]; then',
    '  PY="$ROOT/venv/bin/pip"',
    '  if [ -x "$PY" ]; then "$PY" install -r "$DEST/requirements.txt" || true',
    '  else pip3 install -r "$DEST/requirements.txt" || pip install -r "$DEST/requirements.txt" || true',
    '  fi',
    'fi',
    'touch "$MARKER"',
  ].join('\n')

  const b64 = Buffer.from(work, 'utf8').toString('base64')
  // Kick off and return immediately — critical for RunPod proxy.
  const startCmd = [
    `rm -f ${JSON.stringify(marker)} ${JSON.stringify(failMarker)}`,
    `nohup bash -c 'echo ${b64} | base64 -d | bash || touch ${JSON.stringify(failMarker)}' > ${JSON.stringify(logFile)} 2>&1 &`,
    'echo STARTED',
  ].join('; ')

  console.log(`[my-pod] background-install ${pack.dir} on pod`)
  await onProgress?.(`installing ${pack.dir} (background)…`)
  const started = await sshExec(ssh, startCmd, 60_000)
  if (!started.stdout.includes('STARTED') && started.code !== 0) {
    throw new Error(`Could not start install for ${pack.dir}: ${(started.stderr || started.stdout).slice(-400)}`)
  }

  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 12_000))
    await onProgress?.(`installing ${pack.dir}…`)
    const check = await sshExec(
      ssh,
      [
        `if [ -f ${JSON.stringify(marker)} ]; then echo DONE; exit 0; fi`,
        `if [ -f ${JSON.stringify(failMarker)} ]; then echo FAIL; tail -c 800 ${JSON.stringify(logFile)} 2>/dev/null; exit 1; fi`,
        `echo WAIT; tail -c 200 ${JSON.stringify(logFile)} 2>/dev/null || true`,
      ].join('; '),
      45_000,
    ).catch((err) => ({
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      code: 1,
    }))

    if (check.stdout.includes('DONE')) return
    if (check.stdout.includes('FAIL') || (check.code !== 0 && check.stdout.includes('FAIL'))) {
      throw new Error(`Install failed for ${pack.dir}: ${(check.stdout + check.stderr).slice(-600)}`)
    }
  }
  throw new Error(`Install timed out for ${pack.dir} after 15 minutes`)
}

async function installPacks(opts: {
  ssh: SshAuth
  packs: NodePack[]
  comfyBaseUrl: string
  apiToken?: string | null
  onProgress?: (msg: string) => void | Promise<void>
}): Promise<void> {
  const { ssh, packs, comfyBaseUrl, apiToken, onProgress } = opts

  // 1) Prefer Comfy Manager over HTTP (uses the Comfy URL the user already has).
  const stillNeed: NodePack[] = []
  for (const pack of packs) {
    await onProgress?.(`trying Manager install: ${pack.dir}`)
    const ok = await tryManagerHttpInstall(comfyBaseUrl, pack, apiToken)
    if (ok) {
      // Give Manager a moment; confirm later after restart/probe.
      continue
    }
    stillNeed.push(pack)
  }

  // 2) Anything Manager couldn't take → background SSH install (short sessions).
  if (stillNeed.length) {
    const root = await findComfyRoot(ssh)
    for (const pack of stillNeed) {
      await installPackBackground(ssh, root, pack, onProgress)
    }
  }

  await onProgress?.('restarting ComfyUI…')
  await restartComfyShort(ssh)
}

export type EnsureNodesResult = {
  ok: true
  installed: string[]
  optionalMissing: string[]
} | {
  ok: false
  error: string
  missing: string[]
}

async function ensureNodePacks(opts: {
  label: string
  comfyBaseUrl: string
  apiToken?: string | null
  ssh: SshAuth
  required: readonly string[]
  optional?: readonly string[]
  packs: NodePack[]
  onProgress?: (msg: string) => void | Promise<void>
}): Promise<EnsureNodesResult> {
  const log = async (msg: string) => {
    console.log(`[my-pod/ensure-${opts.label}] ${msg}`)
    await opts.onProgress?.(msg)
  }

  let probe = await probeTypes(
    opts.comfyBaseUrl,
    opts.apiToken,
    opts.required,
    opts.optional ?? [],
  )
  if (probe.optionalMissing.length) {
    await log(`optional missing: ${probe.optionalMissing.join(', ')}`)
  }
  if (probe.missing.length === 0) {
    await log(`all required present: ${probe.present.join(', ')}`)
    return { ok: true, installed: [], optionalMissing: probe.optionalMissing }
  }

  await log(`missing required: ${probe.missing.join(', ')}`)
  const packs = packsForMissing(probe.missing, opts.packs)
  const unsolved = probe.missing.filter(m => !packs.some(p => p.provides.includes(m)))
  if (unsolved.length) {
    return {
      ok: false,
      missing: probe.missing,
      error: `Pod missing Comfy nodes that cannot be auto-installed: ${unsolved.join(', ')}.`,
    }
  }

  try {
    await log(`installing: ${packs.map(p => p.dir).join(', ')}`)
    await installPacks({
      ssh: opts.ssh,
      packs,
      comfyBaseUrl: opts.comfyBaseUrl,
      apiToken: opts.apiToken,
      onProgress: log,
    })
  } catch (err) {
    return {
      ok: false,
      missing: probe.missing,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  await log('waiting for ComfyUI to reload…')
  const up = await waitForComfy(opts.comfyBaseUrl, opts.apiToken, 300_000)
  if (!up) {
    return {
      ok: false,
      missing: probe.missing,
      error: 'Installed custom nodes but ComfyUI did not come back within 5 minutes.',
    }
  }

  await new Promise(r => setTimeout(r, 10_000))
  probe = await probeTypes(
    opts.comfyBaseUrl,
    opts.apiToken,
    opts.required,
    opts.optional ?? [],
  )
  if (probe.missing.length) {
    return {
      ok: false,
      missing: probe.missing,
      error: `Installed packs but still missing: ${probe.missing.join(', ')}.`,
    }
  }

  await log(`OK installed ${packs.map(p => p.dir).join(', ')}`)
  return {
    ok: true,
    installed: packs.map(p => p.dir),
    optionalMissing: probe.optionalMissing,
  }
}

export async function ensureAnimateNodes(opts: {
  comfyBaseUrl: string
  apiToken?: string | null
  ssh: SshAuth
  onProgress?: (msg: string) => void | Promise<void>
}): Promise<EnsureNodesResult> {
  return ensureNodePacks({
    label: 'animate',
    required: ANIMATE_REQUIRED_NODE_TYPES,
    optional: ANIMATE_OPTIONAL,
    packs: ANIMATE_PACKS,
    ...opts,
  })
}

export async function ensureTalkNodes(opts: {
  comfyBaseUrl: string
  apiToken?: string | null
  ssh: SshAuth
  onProgress?: (msg: string) => void | Promise<void>
}): Promise<EnsureNodesResult> {
  return ensureNodePacks({
    label: 'talk',
    required: TALK_REQUIRED_NODE_TYPES,
    packs: TALK_PACKS,
    ...opts,
  })
}
