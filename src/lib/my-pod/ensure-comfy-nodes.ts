/**
 * Probe Comfy /object_info for required node types; auto-install missing
 * custom_nodes packs over SSH; restart Comfy; re-test.
 */
import { comfyHeaders } from '@/lib/my-pod/comfy'
import { sshExec, type SshAuth } from '@/lib/my-pod/ssh'

export interface NodePack {
  provides: string[]
  repo: string
  dir: string
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
    45_000,
  )
  const root = stdout.trim().split('\n').filter(Boolean).pop()
  if (code !== 0 || !root) {
    throw new Error(
      'Could not find ComfyUI/custom_nodes on the pod via SSH. Install the required custom nodes manually.',
    )
  }
  return root
}

async function installPacks(ssh: SshAuth, packs: NodePack[]): Promise<void> {
  const root = await findComfyRoot(ssh)
  for (const pack of packs) {
    const dest = `${root}/custom_nodes/${pack.dir}`
    const script = [
      'set -e',
      `DEST=${JSON.stringify(dest)}`,
      `REPO=${JSON.stringify(pack.repo)}`,
      `ROOT=${JSON.stringify(root)}`,
      'if [ -d "$DEST/.git" ]; then',
      '  echo "updating $DEST"',
      '  git -C "$DEST" pull --ff-only || true',
      'else',
      '  echo "cloning $REPO -> $DEST"',
      '  rm -rf "$DEST"',
      '  git clone --depth 1 "$REPO" "$DEST"',
      'fi',
      'if [ -f "$DEST/requirements.txt" ]; then',
      '  PY="$ROOT/venv/bin/pip"',
      '  if [ -x "$PY" ]; then "$PY" install -r "$DEST/requirements.txt" || true',
      '  else pip3 install -r "$DEST/requirements.txt" || pip install -r "$DEST/requirements.txt" || true',
      '  fi',
      'fi',
      'echo INSTALLED_OK',
    ].join('\n')
    console.log(`[my-pod] installing ${pack.dir} into ${root}/custom_nodes`)
    const { stdout, stderr, code } = await sshExec(ssh, script, 600_000)
    if (code !== 0 || !stdout.includes('INSTALLED_OK')) {
      throw new Error(
        `Failed to install ${pack.dir} on pod: ${(stderr || stdout).slice(-600)}`,
      )
    }
  }

  const restart = [
    'set +e',
    'curl -sS -m 10 -X POST http://127.0.0.1:8188/manager/reboot >/tmp/xxm_reboot.out 2>&1 && echo REBOOT_API_OK',
    'if ! grep -q REBOOT_API_OK /tmp/xxm_reboot.out 2>/dev/null; then',
    '  pkill -f "python.*main.py" 2>/dev/null || pkill -f "ComfyUI/main.py" 2>/dev/null || true',
    '  echo KILLED_COMFY',
    'fi',
    'echo RESTART_TRIGGERED',
  ].join('\n')
  await sshExec(ssh, restart, 60_000)
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
      error:
        `Pod missing Comfy nodes that cannot be auto-installed: ${unsolved.join(', ')}. `
        + `Install them on the pod (or pick a Talk-ready pod), then Test connection.`,
    }
  }

  try {
    await log(`installing via SSH: ${packs.map(p => p.dir).join(', ')}`)
    await installPacks(opts.ssh, packs)
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

  await new Promise(r => setTimeout(r, 8_000))
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
      error:
        `Installed packs but still missing: ${probe.missing.join(', ')}. `
        + `Check Comfy custom_nodes load errors / models on the pod.`,
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
