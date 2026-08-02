'use client'

import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { clearSpend } from '@/lib/monitor/cost-estimate'
import { useStudioSettings } from './studio-settings'
import { DollarSign, Trash2 } from 'lucide-react'

export function CostsTab() {
  const studio = useStudioSettings()

  const allTimeUsd = useMemo(
    () => studio.spendLog.reduce((s, e) => s + e.totalUsd, 0),
    [studio.spendLog],
  )

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="grid sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Today (est.)</CardDescription>
            <CardTitle className="text-2xl tabular-nums flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-primary" />
              {studio.formatUsd(studio.todaySpendUsd)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Last 7 days</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{studio.formatUsd(studio.weekSpendUsd)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>All logged runs</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{studio.formatUsd(allTimeUsd)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Recent runs</CardTitle>
            <CardDescription>
              Seedream Edit keyframe + Seedance 2.0 estimate recorded when you finish a Replicate from this browser. Not a WaveSpeed invoice.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              clearSpend()
              studio.refreshSpend()
            }}
          >
            <Trash2 className="w-4 h-4" />
            Clear log
          </Button>
        </CardHeader>
        <CardContent>
          {studio.spendLog.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center">Empty. Run a replicate first.</p>
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border/50">
                    <th className="py-3 pr-4 font-medium">When</th>
                    <th className="py-3 pr-4 font-medium">Profile</th>
                    <th className="py-3 pr-4 font-medium text-right">Keyframe</th>
                    <th className="py-3 pr-4 font-medium text-right">Video</th>
                    <th className="py-3 font-medium text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {studio.spendLog.slice(0, 40).map(e => (
                    <tr key={e.id} className="border-b border-border/30 last:border-0">
                      <td className="py-3 pr-4 whitespace-nowrap text-muted-foreground">
                        {new Date(e.at).toLocaleString()}
                      </td>
                      <td className="py-3 pr-4">@{e.profile || '—'}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">{studio.formatUsd(e.keyframeUsd)}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">{studio.formatUsd(e.videoUsd)}</td>
                      <td className="py-3 text-right tabular-nums font-medium">{studio.formatUsd(e.totalUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
