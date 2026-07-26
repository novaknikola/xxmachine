import type {
  ImageModelChoice,
  SoundMode,
  VideoBackendChoice,
} from '@/lib/monitor/cost-estimate'

const RECIPES_KEY = 'xxmachine.copyPaste.recipes'
const SPEND_KEY = 'xxmachine.copyPaste.spend'
const ACTIVE_RECIPE_KEY = 'xxmachine.copyPaste.activeRecipe'

export interface CopyPasteRecipe {
  id: string
  name: string
  createdAt: string
  imageModel: ImageModelChoice
  seedreamResolution: '1k' | '2k'
  videoBackend: VideoBackendChoice
  sound: SoundMode
}

export interface SpendEntry {
  id: string
  at: string
  itemId?: string
  profile?: string
  imageModel: string
  videoBackend: string
  sound: string
  imageUsd: number
  videoUsd: number
  audioUsd: number
  totalUsd: number
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  localStorage.setItem(key, JSON.stringify(value))
}

export function listRecipes(): CopyPasteRecipe[] {
  return readJson<CopyPasteRecipe[]>(RECIPES_KEY, [])
}

export function saveRecipe(recipe: Omit<CopyPasteRecipe, 'id' | 'createdAt'> & { id?: string }): CopyPasteRecipe {
  const recipes = listRecipes()
  const next: CopyPasteRecipe = {
    id: recipe.id ?? crypto.randomUUID(),
    name: recipe.name.trim() || 'Untitled recipe',
    createdAt: new Date().toISOString(),
    imageModel: recipe.imageModel,
    seedreamResolution: recipe.seedreamResolution,
    videoBackend: recipe.videoBackend,
    sound: recipe.sound,
  }
  const idx = recipes.findIndex(r => r.id === next.id)
  if (idx >= 0) recipes[idx] = { ...next, createdAt: recipes[idx].createdAt }
  else recipes.unshift(next)
  writeJson(RECIPES_KEY, recipes)
  return next
}

export function deleteRecipe(id: string) {
  writeJson(RECIPES_KEY, listRecipes().filter(r => r.id !== id))
}

export function getActiveRecipeId(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(ACTIVE_RECIPE_KEY)
}

export function setActiveRecipeId(id: string | null) {
  if (typeof window === 'undefined') return
  if (id) localStorage.setItem(ACTIVE_RECIPE_KEY, id)
  else localStorage.removeItem(ACTIVE_RECIPE_KEY)
}

export function listSpend(): SpendEntry[] {
  return readJson<SpendEntry[]>(SPEND_KEY, [])
}

export function recordSpend(entry: Omit<SpendEntry, 'id' | 'at'> & { id?: string; at?: string }) {
  const rows = listSpend()
  rows.unshift({
    id: entry.id ?? crypto.randomUUID(),
    at: entry.at ?? new Date().toISOString(),
    itemId: entry.itemId,
    profile: entry.profile,
    imageModel: entry.imageModel,
    videoBackend: entry.videoBackend,
    sound: entry.sound,
    imageUsd: entry.imageUsd,
    videoUsd: entry.videoUsd,
    audioUsd: entry.audioUsd,
    totalUsd: entry.totalUsd,
  })
  writeJson(SPEND_KEY, rows.slice(0, 500))
}

export function clearSpend() {
  writeJson(SPEND_KEY, [])
}

export function spendTodayUsd(): number {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return listSpend()
    .filter(e => new Date(e.at) >= start)
    .reduce((sum, e) => sum + e.totalUsd, 0)
}
