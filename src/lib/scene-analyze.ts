import { callGrok, GROK_SMART } from './grok'

const SYSTEM = `You are an expert image-generation prompt writer.

Analyze the photo and describe it as a single, precise image-generation prompt:
pose/action, camera angle and framing, background/setting, lighting, and
wardrobe style. Be visual and specific.

RULES:
- 1-3 sentences, direct and concrete
- Describe the scene, not the person's identity — no ethnicity, face shape,
  hair colour, skin tone, age or name. The subject's identity is supplied
  separately; your job is only the scene around them.
- Do not use "she"/"he"/any pronoun or name — describe the pose/action itself
  ("kneeling on the bed, looking over one shoulder toward camera")
- No quality tags ("photorealistic", "8k", etc) — those are added elsewhere
- English only

Return ONLY the prompt text. No quotes, no markdown, no explanation.`

/** Describes one photo's scene (pose, framing, background, lighting, wardrobe) via Grok vision — used to fill in a real prompt for pins/clips that arrived with no text of their own. */
export async function analyzeSceneForPrompt(imageUrl: string): Promise<string> {
  const text = await callGrok({
    model: GROK_SMART,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: 'Describe this scene as an image-generation prompt.' },
      ],
    }],
    maxTokens: 300,
    temperature: 0.5,
  })
  return text.trim()
}

/** Bounded concurrency — many images at once must not fire dozens of parallel Grok calls. */
export async function analyzeScenesForPrompts(imageUrls: string[]): Promise<string[]> {
  const CONCURRENCY = 4
  const results: string[] = new Array(imageUrls.length).fill('')
  let cursor = 0

  async function worker() {
    while (cursor < imageUrls.length) {
      const i = cursor++
      try {
        results[i] = await analyzeSceneForPrompt(imageUrls[i])
      } catch (err) {
        // One failed image must not blank the whole batch — the caller can
        // see which entries came back empty and retry just those.
        results[i] = ''
        console.error('[scene-analyze] failed for', imageUrls[i], err instanceof Error ? err.message : err)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, imageUrls.length) }, worker))
  return results
}
