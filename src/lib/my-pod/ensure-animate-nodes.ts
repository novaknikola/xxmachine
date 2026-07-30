/**
 * Ensure WAN Animate Comfy custom nodes exist on the user's pod.
 * Probes /object_info; if DWPreprocessor (etc.) is missing, installs via SSH
 * into ComfyUI/custom_nodes and waits for Comfy to come back.
 */
import { comfyHeaders } from '@/lib/my-pod/comfy'
import { sshExec, type SshAuth } from '@/lib/my-pod/ssh'

/** Class types the Animate builder must see on the pod. */
export const ANIMATE_REQUIRED_NODE_TYPES = [
  'DWPreprocessor',
  'WanAnimateToVideo',
  'SaveVideo',
] as const

/** Optional face-crop helpers (newer Comfy built-ins; warn only if missing). */
const ANIMATE_OPTIONAL_NODE_TYPES = [
  'SDPoseFaceBBoxes',
  'CropByBBoxes',
] as const

interface NodePack {
  /** Node class_types this pack provides */
  provides: string[]
  /** git clone URL */
  repo: string
  /** directory name under custom_nodes */
  dir: string
}

const INSTALLABLE_PACKS: NodePack[] = [
  {
    provides: ['DWPreprocessor'],
    repo: 'https://github.com/Fannovel16/comfyui_controlnet_aux.git',
    dir: 'comfyui_controlnet_aux',
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

export async function probeAnimateNodeTypes(
  comfyBaseUrl: string,
  apiToken?: string | null,
): Promise<{ present: string[]; missing: string[]; optionalMissing: string[] }> {
  const present: string[] = []
  const missing: string[] = []
  for (const t of ANIMATE_REQUIRED_NODE_TYPES) {
    if (await probeNodeType(comfyBaseUrl, t, apiToken)) present.push(t)
    else missing.push(t)
  }
  const optionalMissing: string[] = []
  for (const t of ANIMATE_OPTIONAL_NODE_TYPES) {
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
    const ok = await probeNodeType(comfyBaseUrl, 'SaveVideo', apiToken, 15_000)
      .catch(() => false)
    if (ok) return true
    await new Promise(r => setTimeout(r, 5_000))
  }
  return false
}

function packsForMissing(missing: string[]): NodePack[] {
  return INSTALLABLE_PACKS.filter(p => p.provides.some(n => missing.includes(n)))
}

/** Find ComfyUI root that has custom_nodes on the pod. */
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
      'Could not find ComfyUI/custom_nodes on the pod via SSH. Install DWPreprocessor (comfyui_controlnet_aux) manually.',
    )
  }
  return root
}

async function installPacks(ssh: SshAuth, packs: NodePack[]): Promise<string[]> {
  const root = await findComfyRoot(ssh)
  const logs: string[] = []
  for (const pack of packs) {
    const dest = `${root}/custom_nodes/${pack.dir}`
    const script = [
      'set -e',
      `ROOT=${JSON.stringify(root)}`,
      `DEST=${JSON.stringify(dest)}`,
      `REPO=${JSON.stringify(pack.repo)}`,
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
    logs.push(`${pack.dir}: exit=${code}\n${stdout.slice(-800)}\n${stderr.slice(-400)}`)
    if (code !== 0 || !stdout.includes('INSTALLED_OK')) {
      throw new Error(
        `Failed to install ${pack.dir} on pod: ${(stderr || stdout).slice(-600)}`,
      )
    }
  }

  // Restart Comfy so new nodes register (Manager reboot if present, else soft kill).
  const restart = [
    'set +e',
    'curl -sS -m 10 -X POST http://127.0.0.1:8188/manager/reboot >/tmp/xxm_reboot.out 2>&1 && echo REBOOT_API_OK',
    'if ! grep -q REBOOT_API_OK /tmp/xxm_reboot.out 2>/dev/null; then',
    '  pkill -f "python.*main.py" 2>/dev/null || pkill -f "ComfyUI/main.py" 2>/dev/null || true',
    '  echo KILLED_COMFY',
    'fi',
    'echo RESTART_TRIGGERED',
  ].join('\n')
  const r = await sshExec(ssh, restart, 60_000)
  logs.push(`restart: ${r.stdout.slice(-400)}`)
  return logs
}

export type EnsureAnimateResult = {
  ok: true
  installed: string[]
  optionalMissing: string[]
} | {
  ok: false
  error: string
  missing: string[]
}

/**
 * Probe Animate node types; auto-install missing installable packs over SSH; re-test.
 */
export async function ensureAnimateNodes(opts: {
  comfyBaseUrl: string
  apiToken?: string | null
  ssh: SshAuth
  onProgress?: (msg: string) => void | Promise<void>
}): Promise<EnsureAnimateResult> {
  const log = async (msg: string) => {
    console.log(`[my-pod/ensure-animate] ${msg}`)
    await opts.onProgress?.(msg)
  }

  let probe = await probeAnimateNodeTypes(opts.comfyBaseUrl, opts.apiToken)
  if (probe.optionalMissing.length) {
    await log(`optional nodes missing (face crop may degrade): ${probe.optionalMissing.join(', ')}`)
  }
  if (probe.missing.length === 0) {
    await log(`all required Animate nodes present: ${probe.present.join(', ')}`)
    return { ok: true, installed: [], optionalMissing: probe.optionalMissing }
  }

  await log(`missing required nodes: ${probe.missing.join(', ')}`)
  const packs = packsForMissing(probe.missing)
  const unsolved = probe.missing.filter(
    m => !packs.some(p => p.provides.includes(m)),
  )
  if (unsolved.length) {
    return {
      ok: false,
      missing: probe.missing,
      error:
        `Pod missing Comfy nodes that cannot be auto-installed: ${unsolved.join(', ')}. `
        + `Install the WAN Animate / WanVideo custom nodes on the pod, then Test connection.`,
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

  await log('waiting for ComfyUI to reload after install…')
  const up = await waitForComfy(opts.comfyBaseUrl, opts.apiToken, 300_000)
  if (!up) {
    return {
      ok: false,
      missing: probe.missing,
      error: 'Installed custom nodes but ComfyUI did not come back within 5 minutes. Check the pod console.',
    }
  }

  // Give node registry a moment after /queue is up
  await new Promise(r => setTimeout(r, 8_000))
  probe = await probeAnimateNodeTypes(opts.comfyBaseUrl, opts.apiToken)
  if (probe.missing.length) {
    return {
      ok: false,
      missing: probe.missing,
      error:
        `Installed packs but still missing: ${probe.missing.join(', ')}. `
        + `Open ComfyUI on the pod and confirm custom_nodes loaded without errors.`,
    }
  }

  await log(`install + re-test OK (${packs.map(p => p.dir).join(', ')})`)
  return {
    ok: true,
    installed: packs.map(p => p.dir),
    optionalMissing: probe.optionalMissing,
  }
}
