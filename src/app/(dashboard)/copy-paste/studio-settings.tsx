'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import {
  estimateReplicateCost,
  formatUsd,
  type ImageModelChoice,
  type SoundMode,
  type VideoBackendChoice,
} from '@/lib/monitor/cost-estimate'
import {
  getActiveRecipeId,
  listRecipes,
  listSpend,
  recordSpend,
  setActiveRecipeId,
  spendTodayUsd,
  type CopyPasteRecipe,
  type SpendEntry,
} from '@/lib/monitor/recipes'

export const VIDEO_BACKEND_OPTIONS: { value: VideoBackendChoice; label: string }[] = [
  { value: 'auto', label: 'Auto (by technique)' },
  { value: 'kling_mc', label: 'Kling motion-control' },
  { value: 'seedance_i2v', label: 'Seedance 2.0 I2V' },
  { value: 'seedance_i2v_turbo', label: 'Seedance 2.0 Turbo' },
  { value: 'ltx_i2v', label: 'LTX 2.3 I2V' },
  { value: 'ltx_i2v_lora', label: 'LTX 2.3 I2V + LoRA' },
  { value: 'wan_i2v', label: 'Wan 2.7 I2V' },
]

export const SOUND_OPTIONS: { value: SoundMode; label: string; hint: string }[] = [
  { value: 'silent', label: 'Silent', hint: 'No audio track' },
  { value: 'source', label: 'Keep source audio', hint: 'Mux original reel sound after video' },
  { value: 'fish', label: 'Fish (my voice)', hint: 'TTS clone — mux after Seedance (coming soon)' },
  { value: 'seedance_native', label: 'AI native audio', hint: 'Seedance generate_audio when that backend runs' },
]

export const IMAGE_MODEL_LABEL: Record<ImageModelChoice, string> = {
  z_image: 'Z-Image (LoRA)',
  seedream_edit: 'Seedream Edit',
}

interface StudioSettings {
  imageModel: ImageModelChoice
  setImageModel: (v: ImageModelChoice) => void
  seedreamResolution: '1k' | '2k'
  setSeedreamResolution: (v: '1k' | '2k') => void
  videoBackend: VideoBackendChoice
  setVideoBackend: (v: VideoBackendChoice) => void
  sound: SoundMode
  setSound: (v: SoundMode) => void
  runMode: 'one' | 'batch'
  setRunMode: (v: 'one' | 'batch') => void
  stopRequested: boolean
  isStopRequested: () => boolean
  requestStopAll: () => Promise<void>
  clearStop: () => void
  queueBusy: number
  setQueueBusy: (n: number | ((prev: number) => number)) => void
  todaySpendUsd: number
  spendLog: SpendEntry[]
  refreshSpend: () => void
  logEstimatedSpend: (input: {
    itemId?: string
    profile?: string
    durationSec?: number | null
  }) => void
  estimateFor: (durationSec?: number | null) => ReturnType<typeof estimateReplicateCost>
  applyRecipe: (recipe: CopyPasteRecipe) => void
  activeRecipeId: string | null
  recipesVersion: number
  bumpRecipes: () => void
  formatUsd: typeof formatUsd
}

const Ctx = createContext<StudioSettings | null>(null)

export function StudioSettingsProvider({ children }: { children: ReactNode }) {
  const [imageModel, setImageModel] = useState<ImageModelChoice>('seedream_edit')
  const [seedreamResolution, setSeedreamResolution] = useState<'1k' | '2k'>('2k')
  const [videoBackend, setVideoBackend] = useState<VideoBackendChoice>('seedance_i2v')
  const [sound, setSound] = useState<SoundMode>('silent')
  const [runMode, setRunMode] = useState<'one' | 'batch'>('one')
  const [stopRequested, setStopRequested] = useState(false)
  const stopRef = useRef(false)
  const [queueBusy, setQueueBusy] = useState(0)
  const [todaySpendUsd, setTodaySpendUsd] = useState(0)
  const [spendLog, setSpendLog] = useState<SpendEntry[]>([])
  const [activeRecipeId, setActiveRecipeIdState] = useState<string | null>(null)
  const [recipesVersion, setRecipesVersion] = useState(0)

  const refreshSpend = useCallback(() => {
    setSpendLog(listSpend())
    setTodaySpendUsd(spendTodayUsd())
  }, [])

  useEffect(() => {
    refreshSpend()
    const id = getActiveRecipeId()
    setActiveRecipeIdState(id)
    if (id) {
      const recipe = listRecipes().find(r => r.id === id)
      if (recipe) {
        setImageModel(recipe.imageModel)
        setSeedreamResolution(recipe.seedreamResolution)
        setVideoBackend(recipe.videoBackend)
        setSound(recipe.sound)
      }
    }
  }, [refreshSpend])

  const estimateFor = useCallback(
    (durationSec?: number | null) =>
      estimateReplicateCost({
        imageModel,
        seedreamResolution,
        videoBackend,
        sound,
        durationSec,
      }),
    [imageModel, seedreamResolution, videoBackend, sound],
  )

  const logEstimatedSpend = useCallback(
    (input: { itemId?: string; profile?: string; durationSec?: number | null }) => {
      const est = estimateFor(input.durationSec)
      recordSpend({
        itemId: input.itemId,
        profile: input.profile,
        imageModel,
        videoBackend,
        sound,
        imageUsd: est.imageUsd,
        videoUsd: est.videoUsd,
        audioUsd: est.audioUsd,
        totalUsd: est.totalUsd,
      })
      refreshSpend()
    },
    [estimateFor, imageModel, videoBackend, sound, refreshSpend],
  )

  const applyRecipe = useCallback((recipe: CopyPasteRecipe) => {
    setImageModel(recipe.imageModel)
    setSeedreamResolution(recipe.seedreamResolution)
    setVideoBackend(recipe.videoBackend)
    setSound(recipe.sound)
    setActiveRecipeId(recipe.id)
    setActiveRecipeIdState(recipe.id)
    toast.success(`Recipe “${recipe.name}” applied`)
  }, [])

  const requestStopAll = useCallback(async () => {
    stopRef.current = true
    setStopRequested(true)
    setQueueBusy(0)
    try {
      const res = await fetch('/api/runpod/profiles')
      const data = await res.json()
      const profiles = (data.profiles ?? []) as Array<{ id: string; autopilot: boolean }>
      const on = profiles.filter(p => p.autopilot)
      await Promise.all(
        on.map(p =>
          fetch('/api/runpod/profiles', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: p.id, autopilot: false }),
          }),
        ),
      )
      toast.success(
        on.length
          ? `Stopped — paused ${on.length} autopilot profile${on.length === 1 ? '' : 's'}`
          : 'Stopped local queue (no autopilot profiles were on)',
      )
    } catch {
      toast.error('Stop requested locally; failed to pause autopilot profiles')
    }
  }, [])

  const value = useMemo<StudioSettings>(
    () => ({
      imageModel,
      setImageModel,
      seedreamResolution,
      setSeedreamResolution,
      videoBackend,
      setVideoBackend,
      sound,
      setSound,
      runMode,
      setRunMode,
      stopRequested,
      isStopRequested: () => stopRef.current,
      requestStopAll,
      clearStop: () => {
        stopRef.current = false
        setStopRequested(false)
      },
      queueBusy,
      setQueueBusy,
      todaySpendUsd,
      spendLog,
      refreshSpend,
      logEstimatedSpend,
      estimateFor,
      applyRecipe,
      activeRecipeId,
      recipesVersion,
      bumpRecipes: () => setRecipesVersion(v => v + 1),
      formatUsd,
    }),
    [
      imageModel,
      seedreamResolution,
      videoBackend,
      sound,
      runMode,
      stopRequested,
      requestStopAll,
      queueBusy,
      todaySpendUsd,
      spendLog,
      refreshSpend,
      logEstimatedSpend,
      estimateFor,
      applyRecipe,
      activeRecipeId,
      recipesVersion,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStudioSettings() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useStudioSettings requires StudioSettingsProvider')
  return ctx
}
