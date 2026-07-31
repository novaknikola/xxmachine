/**
 * Probe Comfy /object_info for required node types; auto-install missing
 * custom_nodes. Designed for RunPod ssh.runpod.io + Comfy proxy URL:
 * at most one short SSH kickoff (background install); progress polled via
 * Comfy HTTP; reboot via Manager HTTP when possible.
 */
import { comfyHeaders } from '@/lib/my-pod/comfy'
import { sshShellExec, type SshAuth } from '@/lib/my-pod/ssh'

export interface NodePack {
  provides: string[]
  repo: string
  dir: string
}

export const ANIMATE_REQUIRED_NODE_TYPES = [
  'DWPreprocessor',
  'Sam2Segmentation',
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
  },
  {
    provides: ['Sam2Segmentation'],
    repo: 'https://github.com/kijai/ComfyUI-segment-anything-2.git',
    dir: 'ComfyUI-segment-anything-2',
  },
]

const TALK_PACKS: NodePack[] = [
  {
    provides: [
      'MultiTalkWav2VecEmbeds',
      'WanVideoImageToVideoMultiTalk',
      'WanVideoSampler',
    ],
    repo: 'https://github.com/kijai/ComfyUI-WanVideoWrapper.git',
    dir: 'ComfyUI-WanVideoWrapper',
  },
  {
    provides: ['VHS_VideoCombine'],
    repo: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git',
    dir: 'ComfyUI-VideoHelperSuite',
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
      const t = setTimeout(() => ctrl.abort(), 90_000)
      try {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers,
          body: typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(body),
          signal: ctrl.signal,
        })
        if (res.ok || res.status === 200 || res.status === 201) {
          console.log(`[my-pod] Manager HTTP install via ${path} → ${pack.dir}`)
          return true
        }
      } catch {
        // next
      } finally {
        clearTimeout(t)
      }
    }
  }
  return false
}

async function rebootComfyHttp(comfyBaseUrl: string, apiToken?: string | null): Promise<boolean> {
  const base = comfyBaseUrl.replace(/\/+$/, '')
  for (const path of ['/manager/reboot', '/api/manager/reboot']) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 20_000)
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: comfyHeaders(apiToken),
        signal: ctrl.signal,
      })
      if (res.ok || res.status === 200) return true
    } catch {
      // next
    } finally {
      clearTimeout(t)
    }
  }
  return false
}

/**
 * Install packs via RunPod interactive SSH shell (exec is broken on ssh.runpod.io).
 * Then reboot Comfy over HTTP and poll until required node types appear.
 */
async function installPacksViaShell(
  ssh: SshAuth,
  packs: NodePack[],
  onProgress?: (msg: string) => void | Promise<void>,
): Promise<void> {
  const lines: string[] = [
    'set +e',
    'ROOT=""',
    'for d in /app/ComfyUI /workspace/ComfyUI /workspace/RunPod-ComfyUI /workspace/comfyui /ComfyUI /root/ComfyUI; do',
    '  if [ -d "$d/custom_nodes" ]; then ROOT="$d"; break; fi',
    'done',
    'if [ -z "$ROOT" ]; then',
    '  CAND=$(ls -d /home/*/ComfyUI/custom_nodes 2>/dev/null | head -1 | sed "s|/custom_nodes||")',
    '  [ -n "$CAND" ] && ROOT="$CAND"',
    'fi',
    'if [ -z "$ROOT" ]; then echo NO_COMFY_ROOT; exit 1; fi',
    'echo ROOT=$ROOT',
  ]

  for (const pack of packs) {
    lines.push(
      `DEST="$ROOT/custom_nodes/${pack.dir}"`,
      `REPO=${JSON.stringify(pack.repo)}`,
      'echo INSTALLING_$DEST',
      'if [ -d "$DEST/.git" ]; then git -C "$DEST" pull --ff-only || true',
      'else rm -rf "$DEST"; git clone --depth 1 "$REPO" "$DEST" || exit 1; fi',
      'if [ -f "$DEST/requirements.txt" ]; then',
      '  if [ -x "$ROOT/venv/bin/pip" ]; then "$ROOT/venv/bin/pip" install -r "$DEST/requirements.txt" || true',
      '  elif [ -x /opt/conda/bin/pip ]; then /opt/conda/bin/pip install -r "$DEST/requirements.txt" || true',
      '  else pip3 install -r "$DEST/requirements.txt" || pip install -r "$DEST/requirements.txt" || true; fi',
      'fi',
    )
  }
  lines.push('echo INSTALLED_OK')

  await onProgress?.('SSH shell install running…')
  const result = await sshShellExec(ssh, lines.join('\n'), 12 * 60_000)
  if (!result.stdout.includes('INSTALLED_OK')) {
    throw new Error(
      `SSH shell install failed: ${result.stdout.slice(-800) || `exit ${result.code}`}`,
    )
  }
}

async function installPacks(opts: {
  ssh: SshAuth
  packs: NodePack[]
  comfyBaseUrl: string
  apiToken?: string | null
  onProgress?: (msg: string) => void | Promise<void>
}): Promise<void> {
  const { ssh, packs, comfyBaseUrl, apiToken, onProgress } = opts
  const neededTypes = [...new Set(packs.flatMap(p => p.provides))]

  let managerOk = true
  for (const pack of packs) {
    await onProgress?.(`Manager install: ${pack.dir}`)
    if (!(await tryManagerHttpInstall(comfyBaseUrl, pack, apiToken))) managerOk = false
  }

  if (!managerOk) {
    await onProgress?.('installing via SSH shell…')
    await installPacksViaShell(ssh, packs, onProgress)
  }

  // Reboot + poll until nodes show up on Comfy HTTP.
  const deadline = Date.now() + 10 * 60_000
  let lastReboot = 0
  while (Date.now() < deadline) {
    await onProgress?.('waiting for custom nodes…')
    const missing: string[] = []
    for (const t of neededTypes) {
      if (!(await probeNodeType(comfyBaseUrl, t, apiToken))) missing.push(t)
    }
    if (missing.length === 0) return

    const now = Date.now()
    if (now - lastReboot > 60_000) {
      lastReboot = now
      await onProgress?.('rebooting ComfyUI…')
      const ok = await rebootComfyHttp(comfyBaseUrl, apiToken)
      if (!ok) {
        await sshShellExec(
          ssh,
          'curl -sS -m 5 -X POST http://127.0.0.1:8188/manager/reboot >/dev/null 2>&1 || pkill -f "python.*main.py" || true; echo REBOOT_TRIED',
          120_000,
        ).catch(() => {})
      }
      await waitForComfy(comfyBaseUrl, apiToken, 180_000)
    }
    await new Promise(r => setTimeout(r, 10_000))
  }
  throw new Error(`Timed out waiting for nodes: ${neededTypes.join(', ')}`)
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
      error: `Still missing after install: ${probe.missing.join(', ')}.`,
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
