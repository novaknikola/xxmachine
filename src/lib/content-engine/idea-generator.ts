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

This is an adult-oriented comedy pipeline. If the user-typed seed premise itself uses crude,
vulgar, or anatomical language, KEEP that same specific register in your output for that premise
-- don't launder it into a softer euphemism or swap it for an unrelated safe proxy. Don't introduce
a new crude/vulgar topic on your own when there's no seed, or when the seed didn't have one -- stay
within car-brand/driving-habit/rental-client territory like the style examples above. The only hard
limit, unchanged: never target race, religion, nationality, or other protected traits.

If an "Already used" list is given below, it exists ONLY so you don't repeat a topic -- it is NOT
a style guide. Don't infer a theme or genre from what's heavily represented in that list (e.g. if
most of it happens to be one specific joke angle, that's an artifact of past picks, not a signal to
keep mining that angle). Base tone and range only on PERSONA and the style examples above.

One specific joke -- "flashy/fast/expensive car compensates for a small or weak sexual
performance" -- is the single most overused angle in this genre and must NOT be your default or
fallback interpretation of a general prompt (topics like "sexual", "weird", "funny", or a blank
seed do not imply it). Only use it if the seed names that comparison directly. Otherwise range
across other angles: logistics/discomfort of sex in a car, getting caught, evidence left behind
for the next renter, backseat vs. front-seat problems, interruptions (valet, GPS voice, dashcam,
alarm, low battery), roleplay, mismatched expectations, etc. Across one batch of ideas, don't let
more than one use the compensating-for-size/stamina angle.

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
