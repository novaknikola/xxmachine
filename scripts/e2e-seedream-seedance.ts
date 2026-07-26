/**
 * End-to-end: Seedream Edit (source frame + girl refs) → Seedance I2V.
 *   npx tsx scripts/e2e-seedream-seedance.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

function loadEnv() {
  const p = join(process.cwd(), '.env.local')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!process.env[m[1]]) process.env[m[1]] = v
  }
}
loadEnv()

const API = 'https://api.wavespeed.ai/api/v3'
const UPLOAD = `${API}/media/upload/binary`
const SEEDREAM = `${API}/bytedance/seedream-v5.0-pro/edit`
const SEEDANCE = `${API}/bytedance/seedance-2.0/image-to-video`
const DIR = join(process.cwd(), 'tmp-e2e')
const OUT = join(DIR, 'out')

const PROMPT = `CRITICAL body proportions (match exactly, do not slim down): large bust straining a button-down shirt, curvy hips, very large rounded glutes filling a tight mini skirt, narrow-to-average waist, thick feminine lower body, soft thighs. Keep the SAME face identity as the reference photos of the woman (long dark brown wavy hair with a thick platinum-blonde front streak / money piece, dark brows, nose stud + septum ring, full lips, light skin).

MUST include these events in the scene: woman walks from left toward wooden podium then leans into gooseneck mic to speak; she later smiles and raises right hand in a wave/gesture; young man in bottom-left foreground starts as back-of-head watching, then turns to camera with wide grin biting his knuckles; semi-transparent caption bar always readable: "those buttons were fighting for their life 💀"

Replace the woman in the auditorium source frame with the woman from the reference photos — same face, hair with platinum streak, piercings — while keeping the auditorium stage, wooden podium, gooseneck microphone, navy curtains, audience heads, outfit concept (tight white long-sleeve button-down tucked into very short black mini skirt), pose, and composition.

Camera: vertical 9:16 audience POV phone video, medium-full mid-thigh up, slight low angle.
Setting: school/college auditorium stage, navy blue curtains, dark wood podium, gooseneck mic, cream wall molding, bright even hall light.
Wardrobe on her body: crisp white long-sleeve button-down stretched across large bust, tucked into high-waisted very short tight black mini skirt.
Hook: comedy UGC meme energy — professional stage vs extremely tight outfit; caption overlay required.
Photorealistic, Instagram Reel still, sharp detail on face matching references.`

const MOTION = `She walks toward the wooden podium, leans into the gooseneck microphone speaking, then smiles and raises her right hand waving to the audience; foreground young man turns to camera biting his knuckles grinning; vertical phone video, natural motion, auditorium lighting, caption stays on screen: those buttons were fighting for their life`

function key(): string {
  const k = process.env.WAVESPEED_API_KEY
  if (!k) throw new Error('WAVESPEED_API_KEY missing')
  return k
}

async function uploadLocal(path: string, filename: string): Promise<string> {
  const buf = readFileSync(path)
  const mime = path.endsWith('.png') ? 'image/png' : 'image/jpeg'
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: mime }), filename)
  const res = await fetch(UPLOAD, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}` },
    body: fd,
  })
  const data = await res.json()
  if (data.code && data.code !== 200) throw new Error(`upload ${filename}: ${data.message ?? JSON.stringify(data)}`)
  const url = data?.data?.download_url as string | undefined
  if (!url) throw new Error(`upload ${filename}: no download_url`)
  console.log('uploaded', filename, url.slice(0, 80) + '…')
  return url
}

async function poll(requestId: string, label: string, everyMs = 4000, max = 120): Promise<string> {
  for (let i = 0; i < max; i++) {
    await new Promise(r => setTimeout(r, everyMs))
    const res = await fetch(`${API}/predictions/${requestId}/result`, {
      headers: { Authorization: `Bearer ${key()}` },
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    process.stdout.write(`\r[${label}] ${status ?? '?'} (${i + 1}/${max})   `)
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error(`${label}: no outputs`)
      console.log('\n', label, 'done')
      return outputs[0] as string
    }
    if (status === 'failed') {
      throw new Error(`${label} failed: ${JSON.stringify(data?.data?.error ?? data)}`)
    }
  }
  throw new Error(`${label} timeout`)
}

async function download(url: string, dest: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  console.log('saved', dest)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const sourceFrame = join(DIR, 'ref_source.jpg')
  const girl1 = join(DIR, 'refs', 'girl1.png')
  const girl2 = join(DIR, 'refs', 'girl2.png')
  for (const p of [sourceFrame, girl1, girl2]) {
    if (!existsSync(p)) throw new Error(`missing ${p}`)
  }

  console.log('1) Upload refs…')
  // Order: source scene first (layout), then identity refs.
  const urls = [
    await uploadLocal(sourceFrame, 'source_frame.jpg'),
    await uploadLocal(girl1, 'girl1.png'),
    await uploadLocal(girl2, 'girl2.png'),
  ]

  console.log('\n2) Seedream Edit…')
  const seedreamInit = await fetch(SEEDREAM, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      images: urls,
      prompt: PROMPT,
      aspect_ratio: '9:16',
      resolution: '1k',
    }),
  }).then(r => r.json())
  if (seedreamInit.code && seedreamInit.code !== 200) {
    throw new Error('Seedream submit: ' + (seedreamInit.message ?? JSON.stringify(seedreamInit)))
  }
  const seedreamId = seedreamInit?.data?.id ?? seedreamInit?.id
  if (!seedreamId) throw new Error('No Seedream request id')
  const imageUrl = await poll(seedreamId, 'seedream', 3000)
  writeFileSync(join(OUT, 'seedream_url.txt'), imageUrl)
  await download(imageUrl, join(OUT, 'seedream.jpg'))

  console.log('\n3) Seedance I2V…')
  const seedanceInit = await fetch(SEEDANCE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image: imageUrl,
      prompt: MOTION,
      aspect_ratio: '9:16',
      resolution: '720p',
      duration: 7,
      generate_audio: false,
      enable_web_search: false,
    }),
  }).then(r => r.json())
  if (seedanceInit.code && seedanceInit.code !== 200) {
    throw new Error('Seedance submit: ' + (seedanceInit.message ?? JSON.stringify(seedanceInit)))
  }
  const seedanceId = seedanceInit?.data?.id ?? seedanceInit?.id
  if (!seedanceId) throw new Error('No Seedance request id')
  const videoUrl = await poll(seedanceId, 'seedance', 5000, 90)
  writeFileSync(join(OUT, 'seedance_url.txt'), videoUrl)
  await download(videoUrl, join(OUT, 'seedance.mp4'))

  console.log('\nDONE')
  console.log('image:', imageUrl)
  console.log('video:', videoUrl)
  console.log('local:', join(OUT, 'seedream.jpg'), join(OUT, 'seedance.mp4'))
}

main().catch(e => {
  console.error('\nERROR', e instanceof Error ? e.message : e)
  process.exit(1)
})
