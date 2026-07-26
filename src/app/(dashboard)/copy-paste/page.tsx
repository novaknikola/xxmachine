'use client'

import { Copy, OctagonX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StudioSettingsProvider, useStudioSettings } from './studio-settings'
import { RunTab } from './run-tab'
import { AutopilotTab } from './autopilot-tab'
import { RecipesTab } from './recipes-tab'
import { CostsTab } from './costs-tab'

function StudioChrome({ children }: { children: React.ReactNode }) {
  const studio = useStudioSettings()

  return (
    <div className="flex flex-col min-h-full">
      <div className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-md">
        <div className="px-6 sm:px-8 pt-6 pb-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Copy className="w-6 h-6 text-primary shrink-0" />
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight">Copy-Paste Studio</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Run · Autopilot · Recipes · Costs — one pipeline, roomier controls
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {studio.queueBusy > 0 && (
              <Badge variant="secondary" className="h-8 px-3 text-sm">
                Queue {studio.queueBusy}
              </Badge>
            )}
            {studio.stopRequested && (
              <Badge variant="outline" className="h-8 px-3 text-sm border-destructive/40 text-destructive">
                Stopped
              </Badge>
            )}
            <div className="rounded-lg border border-border/60 bg-secondary/30 px-3.5 py-2 text-sm">
              <span className="text-muted-foreground">Today </span>
              <span className="font-semibold tabular-nums">{studio.formatUsd(studio.todaySpendUsd)}</span>
            </div>
            <Button variant="destructive" onClick={() => studio.requestStopAll()}>
              <OctagonX className="w-4 h-4" />
              Stop all
            </Button>
          </div>
        </div>
      </div>
      {children}
    </div>
  )
}

function StudioBody() {
  return (
    <StudioChrome>
      <div className="px-6 sm:px-8 py-6 max-w-6xl w-full">
        <Tabs defaultValue="run" className="gap-6">
          <TabsList variant="line" className="w-full sm:w-auto justify-start h-auto flex-wrap">
            <TabsTrigger value="run">Run</TabsTrigger>
            <TabsTrigger value="autopilot">Autopilot</TabsTrigger>
            <TabsTrigger value="recipes">Recipes</TabsTrigger>
            <TabsTrigger value="costs">Costs</TabsTrigger>
          </TabsList>
          <TabsContent value="run" className="mt-2">
            <RunTab />
          </TabsContent>
          <TabsContent value="autopilot" className="mt-2">
            <AutopilotTab />
          </TabsContent>
          <TabsContent value="recipes" className="mt-2">
            <RecipesTab />
          </TabsContent>
          <TabsContent value="costs" className="mt-2">
            <CostsTab />
          </TabsContent>
        </Tabs>
      </div>
    </StudioChrome>
  )
}

export default function CopyPastePage() {
  return (
    <StudioSettingsProvider>
      <StudioBody />
    </StudioSettingsProvider>
  )
}
