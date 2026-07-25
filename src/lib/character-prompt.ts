import type { Character } from './types'

/** Base style + locked hair fragment for consistent branded generation. */
export function buildCharacterStylePrefix(char?: Pick<Character, 'basePromptStyle' | 'hairLock'> | null): string {
  const parts: string[] = []
  if (char?.basePromptStyle?.trim()) parts.push(char.basePromptStyle.trim())
  if (char?.hairLock?.trim()) parts.push(char.hairLock.trim())
  return parts.join(', ')
}

export function buildStyledScenePrompt(
  char: Pick<Character, 'basePromptStyle' | 'hairLock'> | undefined | null,
  scenePrompt: string,
): string {
  const prefix = buildCharacterStylePrefix(char)
  const scene = scenePrompt.trim()
  if (!prefix) return scene
  if (!scene) return prefix
  return `${prefix}, ${scene}`
}

/** Prepends LoRA trigger word when missing from prompt. */
export function withTriggerWord(prompt: string, triggerWord?: string | null): string {
  const word = triggerWord?.trim()
  if (!word) return prompt
  if (prompt.toLowerCase().includes(word.toLowerCase())) return prompt
  return `${word}, ${prompt}`
}
