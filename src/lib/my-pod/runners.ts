import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  uploadImageToComfy,
  submitComfyPrompt,
  pollComfyResult,
  downloadFromComfy,
} from '@/lib/my-pod/comfy'
import { sftpUpload, type SshAuth } from '@/lib/my-pod/ssh'

const WORKERS_DIR = join(process.cwd(), 'workers', 'my_pod')

export function i2vTemplatePath(): string {
  return process.env.MY_POD_I2V_TEMPLATE_PATH
    || join(WORKERS_DIR, 'templates', 'Wan22_I2V_api_template.json')
}

export function animateWorkflowPath(): string {
  return process.env.MY_POD_ANIMATE_WORKFLOW_PATH
    || join(WORKERS_DIR, 'templates', 'Wan22_Animate.json')
}

const I2V_NODE_IDS = {
  load_image: '44',
  positive_prompt: '24',
  negative_prompt: '25',
  image_to_video: '43',
  save_video: '16',
  sampler_high_noise: '49',
  sampler_low_noise: '50',
}

export const DEFAULT_I2V_PROMPT = 'woman smiling and tilting head slowly, subtle natural movement'

function runPython(script: string, env: Record<string, string>, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.MY_POD_PYTHON || 'python3', [script], {
      env: { ...process.env, ...env },
      cwd: WORKERS_DIR,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Python sidecar timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(stderr.trim() || stdout.trim() || `python exit ${code}`))
      else resolve({ stdout, stderr })
    })
  })
}

/** Run one I2V job against remote ComfyUI. */
export async function runI2vItem(opts: {
  comfyBaseUrl: string
  apiToken?: string | null
  ssh: SshAuth
  imageBuffer: Buffer
  imageName: string
  prompt?: string
  jobId: string
}): Promise<{ buffer: Buffer; filename: string }> {
  const templatePath = i2vTemplatePath()
  if (!existsSync(templatePath)) {
    throw new Error(
      `I2V template missing at ${templatePath}. Export Wan22_I2V (API format) from ComfyUI and place it there (see docs/my-pod.md).`,
    )
  }

  const remoteName = `xxm_i2v_${randomUUID().slice(0, 8)}_${opts.imageName.replace(/[^\w.-]/g, '_')}`
  let uploadedName: string
  try {
    uploadedName = await uploadImageToComfy(opts.comfyBaseUrl, opts.imageBuffer, remoteName, opts.apiToken)
  } catch {
    await sftpUpload(opts.ssh, `/app/ComfyUI/input/${remoteName}`, opts.imageBuffer)
    uploadedName = remoteName
  }

  const api = JSON.parse(readFileSync(templatePath, 'utf8')) as Record<string, { inputs: Record<string, unknown> }>
  const ids = I2V_NODE_IDS
  if (!api[ids.load_image]) throw new Error(`I2V template missing load_image node ${ids.load_image}`)
  api[ids.load_image].inputs.image = uploadedName
  if (api[ids.positive_prompt]) api[ids.positive_prompt].inputs.text = opts.prompt || DEFAULT_I2V_PROMPT
  const seed = Math.floor(Math.random() * 2 ** 32)
  for (const key of ['sampler_high_noise', 'sampler_low_noise'] as const) {
    const id = ids[key]
    if (api[id]?.inputs) api[id].inputs.noise_seed = seed
  }
  if (api[ids.save_video]?.inputs) {
    api[ids.save_video].inputs.filename_prefix = `i2v/${opts.jobId}`
  }

  const promptId = await submitComfyPrompt(opts.comfyBaseUrl, api, opts.apiToken)
  const outputs = await pollComfyResult(opts.comfyBaseUrl, promptId, {
    apiToken: opts.apiToken,
    maxAttempts: 720,
    intervalMs: 5000,
    preferNodeId: ids.save_video,
  })
  const video = outputs.find(f => /\.(mp4|webm|gif)$/i.test(f.filename)) ?? outputs[0]
  const buffer = await downloadFromComfy(opts.comfyBaseUrl, video, opts.apiToken)
  return { buffer, filename: video.filename }
}

/** Run one Animate job via Python build_api + remote Comfy. */
export async function runAnimateItem(opts: {
  comfyBaseUrl: string
  apiToken?: string | null
  ssh: SshAuth
  imageBuffer: Buffer
  imageName: string
  videoBuffer: Buffer
  videoName: string
  drivingFrames?: number
  jobId: string
}): Promise<{ buffer: Buffer; filename: string }> {
  const workflowPath = animateWorkflowPath()
  if (!existsSync(workflowPath)) {
    throw new Error(
      `Animate UI workflow missing at ${workflowPath}. Copy Wan22_Animate.json there (see docs/my-pod.md).`,
    )
  }
  const runScript = join(WORKERS_DIR, 'animate_run.py')
  if (!existsSync(runScript)) {
    throw new Error('Animate Python sidecar missing: workers/my_pod/animate_run.py')
  }

  const imgRemote = `xxm_anim_${randomUUID().slice(0, 8)}_${opts.imageName.replace(/[^\w.-]/g, '_')}`
  const vidRemote = `xxm_anim_${randomUUID().slice(0, 8)}_${opts.videoName.replace(/[^\w.-]/g, '_')}`

  try {
    await uploadImageToComfy(opts.comfyBaseUrl, opts.imageBuffer, imgRemote, opts.apiToken)
  } catch {
    await sftpUpload(opts.ssh, `/app/ComfyUI/input/${imgRemote}`, opts.imageBuffer)
  }
  await sftpUpload(opts.ssh, `/app/ComfyUI/input/${vidRemote}`, opts.videoBuffer)

  const { stdout } = await runPython(runScript, {
    COMFY_URL: opts.comfyBaseUrl,
    COMFY_API_TOKEN: opts.apiToken ?? '',
    WORKFLOW_PATH: workflowPath,
    IMAGE_FILE: imgRemote,
    DRIVING_FILE: vidRemote,
    DRIVING_FRAMES: String(opts.drivingFrames ?? 362),
    OUTPUT_PREFIX: `video/xxm_${opts.jobId}`,
    JOB_TIMEOUT_SEC: '3600',
  }, 3_600_000)

  const m = stdout.match(/DONE filename=(\S+) subfolder=(\S*)/)
  if (!m) throw new Error(`Animate sidecar unexpected output: ${stdout.slice(-800)}`)
  const filename = m[1]
  const subfolder = m[2] === '-' ? '' : m[2]
  const buffer = await downloadFromComfy(
    opts.comfyBaseUrl,
    { filename, subfolder, type: 'output' },
    opts.apiToken,
  )
  return { buffer, filename }
}
