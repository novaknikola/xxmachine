import { callGrok, base64ImageContent, GROK_SMART, type GrokMessage } from './grok'

/**
 * The two lesson-prep templates the teacher gave verbatim — used as the Grok
 * system prompt as-is (they're already written as instructions to an AI).
 * Keep these in sync with her wording; do not "improve" the phrasing, the
 * exact activity types/order are what she reviewed and approved.
 */

const OUTPUT_FORMAT_RULE = `
Write your entire reply as plain text only — no markdown symbols (no #, no **, no _, no backticks). Use CAPITAL LETTERS for section headers/activity titles, blank lines between sections, and plain numbers or hyphens for lists — matching the style of the instructions below. This will be pasted directly into a Google Doc a teacher reads in class.
`.trim()

export const GRADES_6_8_SYSTEM_PROMPT = `${OUTPUT_FORMAT_RULE}

PART 1 — GRADES 6–8: CLASS PRACTICE ACTIVITIES
I will give you the textbook, page number and/or the content covered in that lesson.

First, analyse what the students are learning on that page. Identify the main grammar, vocabulary, topic and useful language.

Then create 3–4 short classroom activities based on that content.

Use a variety of the following activity types:

1. Complete the sentences
Give the target word or verb in brackets.

Example:

He always ________ me when I need help. (help)
My sister ________ very creative. (be)
They ________ football every Saturday. (play)
The students must complete the sentence with the correct form.

2. Put the words in the correct order
Example:

very / my / is / friendly / teacher
usually / football / I / play / after school
doing / what / you / are / now?
3. Complete the sentence and speak
Give students a sentence starter that they complete with their own information and then say aloud.

Examples:

My best friend is __________ because __________.
I usually __________ after school.
At the moment, I am __________.
I would like to learn __________ because __________.
4. Speaking questions
Create simple questions related to the lesson topic.

Examples:

What do you usually do after school?
What are you doing now?
What is your best friend like?
What sport do you like?
What are you good at?
5. Choose and explain
Give students two options and ask them to choose one and give a simple reason.

Example:

Which do you prefer?

playing football OR playing computer games
staying at home OR going out
Students answer:

I prefer __________ because __________.

6. Find the missing word / letters
Use vocabulary from the lesson.

Examples:

f_ _endly → friendly
cr_ative → creative
h_lpf_l → helpful
Or:

My teacher is very ________. She always helps us.
(helpful)

7. Short partner questions
Create 10 questions that students can ask each other and answer using complete sentences.

Do not make the activities unnecessarily difficult. The students are Vietnamese learners of English, so avoid vocabulary or sentence structures that are significantly above the level of the textbook.

The activities should gradually move from easy → medium → slightly more challenging.`

export const GRADE_9_SYSTEM_PROMPT = `${OUTPUT_FORMAT_RULE}

GRADE 9 – SPEAKING LESSON
I will give you only the topic. Create a short speaking lesson that teaches students how to give a structured 1–2 minute talk.

Divide the lesson into exactly 3 main parts: INTRODUCTION → DEVELOPMENT → CONCLUSION.
MAKE THEM EXAMPLEX CONNECTED TO THE TOPIC

1. INTRODUCTION
Teach students different natural ways to introduce the topic, such as:

Today, I'm going to talk about...
Today, I'd like to talk about...
My topic today is...
I'd like to tell you about...
I'd like to start by talking about...
I'd like to begin with...
When we talk about ..., ...
When it comes to ..., ...
Give concrete example sentences using the actual topic.

Do not just list phrases.

2. DEVELOPMENT
Teach students how to develop their ideas.

Give useful expressions for:

Moving to a specific aspect of the topic

When it comes to...
As for...
Speaking of...
When we think about...
Regarding...
As far as ... is concerned...
Giving an opinion

I think...
In my opinion...
Personally, I believe...
From my point of view...
Giving a reason

This is because...
The main reason is...
One reason is...
I feel this way because...
Giving an example

For example...
For instance...
A good example of this is...
One example from my experience is...
Adding another idea

Also,...
Another important point is...
Another thing to consider is...
What's more,...
Showing contrast

However,...
On the other hand,...
While some people..., others...
Although...
For each function, give real example sentences related to the topic I provide.

Then give students 2–3 simple techniques for developing ideas, depending on the topic, such as:

TOP 3
Think of the three most important/interesting things about the topic and develop each one.

OPINION → REASON → EXAMPLE
Say what you think → explain why → give an example.

PRO → CON → OPINION
Give one positive point → one negative point → your opinion.

Show exactly how the technique works with the actual topic.

3. CONCLUSION
Teach students different ways to finish their talk:

To sum up,...
To conclude,...
Overall, I think...
All in all,...
To finish, I'd say...
In the end,...
The main point I'd like to make is...
Personally, I believe...
So, overall,...
Give concrete conclusion examples using the actual topic.

MODEL SPEAKING
After teaching the three parts, give one complete model answer about the actual topic:

INTRODUCTION → DEVELOPMENT → CONCLUSION

Clearly show which sentences belong to each part.

The model should demonstrate how to:

introduce the topic
move between ideas
give opinions
give reasons
give examples
add another point
conclude naturally
SPEAKING PRACTICE
Create 5–8 questions related to the topic.

For each question, give:

a useful expression students can use
a complete example answer
Keep the language appropriate for Grade 9.`

export type LessonMode = 'grades-6-8' | 'grade-9'

export interface GenerateLessonInput {
  mode: LessonMode
  /** Free text: page/content description (6-8) or the topic (grade 9). */
  text: string
  /** Textbook page photo(s), if any. */
  images?: { buffer: Buffer; contentType: string }[]
}

export async function generateLessonContent(input: GenerateLessonInput): Promise<string> {
  const system = input.mode === 'grade-9' ? GRADE_9_SYSTEM_PROMPT : GRADES_6_8_SYSTEM_PROMPT

  const intro = input.mode === 'grade-9'
    ? `Topic for the Grade 9 speaking lesson: ${input.text || '(see attached image)'}`
    : `Textbook content for this Grades 6-8 lesson: ${input.text || '(see attached image)'}`

  const content: GrokMessage['content'] = input.images?.length
    ? [
        { type: 'text' as const, text: intro },
        ...input.images.map(img => base64ImageContent(img.buffer.toString('base64'), img.contentType)),
      ]
    : intro

  return callGrok({
    model: GROK_SMART,
    system,
    messages: [{ role: 'user', content }],
    maxTokens: 4096,
    temperature: 0.6,
    timeoutMs: 120_000,
  })
}

const GRADE_9_RE = /\bgrade\s*9\b|\b9th\s*grade\b/i
const GRADE_6_8_RE = /\bgrade\s*(6|7|8)\b|\bgrades?\s*6\s*-\s*8\b/i

export interface ParsedRequest {
  mode: LessonMode
  /** The grade number/label detected, for filenames (e.g. "7", "9", "6-8"). */
  gradeLabel: string
  /** The free text with the grade token stripped out. */
  text: string
}

/** Reads the teacher's caption/text to decide which template applies. Returns null if no grade could be detected and there's no image to fall back on. */
export function parseTeacherRequest(rawText: string, hasImage: boolean): ParsedRequest | null {
  const text = (rawText ?? '').trim()

  if (GRADE_9_RE.test(text)) {
    return { mode: 'grade-9', gradeLabel: '9', text: text.replace(GRADE_9_RE, '').replace(/^[\s:.\-–]+/, '').trim() }
  }

  const m68 = text.match(GRADE_6_8_RE)
  if (m68) {
    const gradeLabel = m68[1] ?? '6-8'
    return { mode: 'grades-6-8', gradeLabel, text: text.replace(GRADE_6_8_RE, '').replace(/^[\s:.\-–]+/, '').trim() }
  }

  // No explicit grade mentioned: only safe to guess when there's a photo to
  // analyse (the common case — she just snaps the page). Pure text with no
  // grade token is too ambiguous (could be either template) to guess.
  if (hasImage) {
    return { mode: 'grades-6-8', gradeLabel: '6-8', text }
  }
  return null
}
