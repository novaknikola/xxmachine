import { callGrok, GROK_FAST } from './grok'

/** Generates brand-new image-gen prompts inspired by the style/format of `examples` via Grok. */
export async function generatePromptVariants(examples: string[], count: number, hint?: string): Promise<string[]> {
  const prompt = `Here are ${examples.length} example AI image-generation prompts, all written in the same descriptive prose style:

${examples.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Generate ${count} BRAND NEW prompts that match the same descriptive prose style, structure, and level of detail as these examples (pose, wardrobe, setting, lighting, camera/photography style) — but with genuinely different content, not reworded copies of the examples. Each one should also be distinct from the others.
${hint?.trim() ? `\nAdditional direction: ${hint.trim()}` : ''}

Rules:
- Do NOT include any name for the subject.
- Do NOT mention a specific hair color, eye color, or nationality/ethnicity.
- Do NOT reuse the same opening sentence structure across multiple prompts in this batch — vary the setup.
- Keep the same overall style as the examples (e.g. "Ultra realistic 4K photo of a ... woman ...").

Return ONLY a JSON object: {"prompts": ["...", "...", ...]} with exactly ${count} strings.`

  const raw = await callGrok({
    model: GROK_FAST,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 4096,
    temperature: 1.0,
    json: true,
    timeoutMs: 170_000,
  })

  let parsed: { prompts?: unknown }
  try {
    parsed = JSON.parse(raw) as { prompts?: unknown }
  } catch {
    throw new Error('Grok returned an incomplete response — try again')
  }
  if (!Array.isArray(parsed.prompts)) throw new Error('Invalid response: missing prompts array')
  return parsed.prompts.map(p => String(p).trim()).filter(Boolean)
}
