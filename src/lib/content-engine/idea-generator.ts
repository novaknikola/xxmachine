import { callGrok, GROK_SMART } from '@/lib/grok'
import { PERSONA } from './script-writer'

/**
 * Content Engine — topic idea suggestions. Same isolation rule as
 * script-writer.ts: only generic infra (@/lib/grok), nothing from
 * src/lib/monitor/*.
 */

const SYSTEM_PROMPT = `You brainstorm short topic briefs for a car-rental social media joke format:
a woman sits in the driver's seat of a rental car, an unseen interviewer asks her things, she
answers with a joke/punchline.

PERSONA: ${PERSONA}

Each idea is ONE short line naming a premise a joke can be built on -- a car brand stereotype, a
driving habit, or a rental-client behavior. Style examples (for tone only, don't reuse):
"BMW drivers who never signal", "clients who return the car with an empty tank", "guys who ask
if the car comes with her number".

This is an adult-oriented comedy pipeline. If the input premise uses crude, vulgar, or anatomical
language, KEEP that register in your output -- repeat the same explicit words/idea, don't launder
it into a softer euphemism or an unrelated safe proxy (e.g. if told the premise is about penis
size, write ideas that say that directly, not "he drives a fast car" as a stand-in for it). The
only hard limit, unchanged: never target race, religion, nationality, or other protected traits.

OUTPUT FORMAT: a single JSON object: { "ideas": ["<topic 1>", "<topic 2>", ...] }
Output exactly the requested count, each one distinct in premise (don't just reword the same
joke), no commentary, no markdown fences.`

export async function generateTopicIdeas(
  existingTopics: string[],
  opts?: { count?: number; seed?: string },
): Promise<string[]> {
  const count = opts?.count ?? 8
  const seed = opts?.seed?.trim()
  const avoid = existingTopics.length
    ? `\n\nAlready used -- do not repeat these or close variants:\n${existingTopics.map(t => `- ${t}`).join('\n')}`
    : ''
  const userPrompt = seed
    ? `Generate ${count} new topic ideas that riff on this premise -- same subject and tone, each a ` +
      `distinct joke angle, don't just reword it: "${seed}"${avoid}`
    : `Generate ${count} new topic ideas.${avoid}`

  const raw = await callGrok({
    model: GROK_SMART,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 512,
    temperature: 1.0,
    json: true,
    timeoutMs: 60_000,
  })

  const parsed: { ideas?: string[] } = JSON.parse(raw)
  const ideas = (parsed.ideas ?? []).map(s => s.trim()).filter(Boolean)
  if (!ideas.length) throw new Error('No ideas returned')
  return ideas
}
