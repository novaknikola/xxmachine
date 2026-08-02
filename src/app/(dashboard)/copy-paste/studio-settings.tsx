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
  type SpendEntry,
} from '@/lib/monitor/cost-estimate'

interface StudioSettings {
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
  estimateFor: (durationSec?: number | null) => ReturnType<typeof estimateCopyPasteCost>
  formatUsd: typeof formatUsd
}

const Ctx = createContext<StudioSettings | null>(null)

export function StudioSettingsProvider({ children }: { children: ReactNode }) {
  const [runMode, setRunMode] = useState<'one' | 'batch'>('one')
  const [stopRequested, setStopRequested] = useState(false)
  const stopRef = useRef(false)
  const [queueBusy, setQueueBusy] = useState(0)
  const [todaySpendUsd, setTodaySpendUsd] = useState(0)
  const [spendLog, setSpendLog] = useState<SpendEntry[]>([])

  const refreshSpend = useCallback(() => {
    setSpendLog(listSpend())
    setTodaySpendUsd(spendTodayUsd())
  }, [])

  useEffect(() => {
    refreshSpend()
  }, [refreshSpend])

  const estimateFor = useCallback(
    (durationSec?: number | null) => estimateCopyPasteCost(durationSec),
    [],
  )

  const logEstimatedSpend = useCallback(
    (input: { itemId?: string; profile?: string; durationSec?: number | null }) => {
      const est = estimateFor(input.durationSec)
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
      formatUsd,
    }),
    [
      runMode,
      stopRequested,
      requestStopAll,
      queueBusy,
      todaySpendUsd,
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
