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
  estimateCopyPasteCost,
  formatUsd,
  listSpend,
  recordSpend,
  spendTodayUsd,
  spendWeekUsd,
  type SpendEntry,
} from '@/lib/monitor/cost-estimate'
import type { EndFrameMode } from '@/lib/monitor/types'

interface StudioSettings {
  runMode: 'one' | 'batch'
  setRunMode: (v: 'one' | 'batch') => void
  endFrame: EndFrameMode
  setEndFrame: (v: EndFrameMode) => void
  /** Repurposed variants to fan each finished video into. 0 = off. */
  repurposeCount: number
  setRepurposeCount: (v: number) => void
  stopRequested: boolean
  isStopRequested: () => boolean
  requestStopAll: () => Promise<void>
  clearStop: () => void
  queueBusy: number
  setQueueBusy: (n: number | ((prev: number) => number)) => void
  todaySpendUsd: number
  weekSpendUsd: number
  spendLog: SpendEntry[]
  refreshSpend: () => void
  logEstimatedSpend: (input: {
    itemId?: string
    profile?: string
    durationSec?: number | null
    cutCount?: number | null
  }) => void
  estimateFor: (durationSec?: number | null, cutCount?: number | null) => ReturnType<typeof estimateCopyPasteCost>
  formatUsd: typeof formatUsd
}

/** Mirrors the server-side eligibility rule so the quoted price matches what runs. */
function endFrameApplies(mode: EndFrameMode, cutCount?: number | null): boolean {
  if (mode === 'off') return false
  if (mode === 'always') return true
  return cutCount === 0
}

const Ctx = createContext<StudioSettings | null>(null)

export function StudioSettingsProvider({ children }: { children: ReactNode }) {
  const [runMode, setRunMode] = useState<'one' | 'batch'>('one')
  const [endFrame, setEndFrame] = useState<EndFrameMode>('auto')
  const [repurposeCount, setRepurposeCount] = useState(0)
  const [stopRequested, setStopRequested] = useState(false)
  const stopRef = useRef(false)
  const [queueBusy, setQueueBusy] = useState(0)
  const [todaySpendUsd, setTodaySpendUsd] = useState(0)
  const [weekSpendUsd, setWeekSpendUsd] = useState(0)
  const [spendLog, setSpendLog] = useState<SpendEntry[]>([])

  // Totals are computed here, not during a component's render: they read the
  // clock, which makes them unstable if recomputed on every re-render.
  const refreshSpend = useCallback(() => {
    setSpendLog(listSpend())
    setTodaySpendUsd(spendTodayUsd())
    setWeekSpendUsd(spendWeekUsd())
  }, [])

  // Mount-time read of the localStorage spend log. It cannot be a lazy useState
  // initializer: the server renders zeroes and the client would then hydrate
  // with real totals, which is a mismatch. Loading after mount is the trade-off.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshSpend()
  }, [refreshSpend])

  const estimateFor = useCallback(
    (durationSec?: number | null, cutCount?: number | null) =>
      estimateCopyPasteCost(durationSec, { endFrame: endFrameApplies(endFrame, cutCount) }),
    [endFrame],
  )

  const logEstimatedSpend = useCallback(
    (input: {
      itemId?: string
      profile?: string
      durationSec?: number | null
      cutCount?: number | null
    }) => {
      const est = estimateFor(input.durationSec, input.cutCount)
      recordSpend({
        itemId: input.itemId,
        profile: input.profile,
        keyframeUsd: est.keyframeUsd,
        videoUsd: est.videoUsd,
        totalUsd: est.totalUsd,
      })
      refreshSpend()
    },
    [estimateFor, refreshSpend],
  )

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
      runMode,
      setRunMode,
      endFrame,
      setEndFrame,
      repurposeCount,
      setRepurposeCount,
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
      weekSpendUsd,
      spendLog,
      refreshSpend,
      logEstimatedSpend,
      estimateFor,
      formatUsd,
    }),
    [
      runMode,
      endFrame,
      repurposeCount,
      stopRequested,
      requestStopAll,
      queueBusy,
      todaySpendUsd,
      weekSpendUsd,
      spendLog,
      refreshSpend,
      logEstimatedSpend,
      estimateFor,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStudioSettings() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useStudioSettings requires StudioSettingsProvider')
  return ctx
}
