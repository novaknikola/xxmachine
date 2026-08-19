'use client'

import { Copy, OctagonX, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { StudioSettingsProvider, useStudioSettings } from './studio-settings'
import { RunTab } from './run-tab'
import { CostsTab } from './costs-tab'
import { ImageToVideoTab } from './image-to-video-tab'
import { InfiniteTalkTab } from './infinite-talk-tab'
import { ContentEngineTab } from './content-engine-tab'

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
                Reel → analysis JSON → reference photo → Seedance 2.0
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
            {/* Costs stopped being a tab: it is something you check, not a
                place you work, so it opens from the number itself. */}
            <Dialog>
              <DialogTrigger className="rounded-lg border border-border/60 bg-secondary/30 px-3.5 py-2 text-sm hover:border-border hover:bg-secondary/50 transition-colors">
                <span className="text-muted-foreground">Today </span>
                <span className="font-semibold tabular-nums">{studio.formatUsd(studio.todaySpendUsd)}</span>
              </DialogTrigger>
              <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Costs</DialogTitle>
                </DialogHeader>
                <CostsTab />
              </DialogContent>
            </Dialog>
            {studio.stopRequested ? (
              <Button
                variant="default"
                onClick={() => {
                  studio.clearStop()
                  toast.success('Ready — Replicate / Autopilot can run again')
                }}
              >
                <Play className="w-4 h-4" />
                Play
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => studio.requestStopAll()}>
                <OctagonX className="w-4 h-4" />
                Stop all
              </Button>
            )}
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
            <TabsTrigger value="run">Seedance Viral</TabsTrigger>
            <TabsTrigger value="i2v">Image to Video</TabsTrigger>
            <TabsTrigger value="talk">Infinite Talk</TabsTrigger>
            <TabsTrigger value="content-engine">Content Engine</TabsTrigger>
          </TabsList>
          <TabsContent value="run" className="mt-2">
            <RunTab />
          </TabsContent>
          <TabsContent value="i2v" className="mt-2">
            <ImageToVideoTab />
          </TabsContent>
          <TabsContent value="talk" className="mt-2">
            <InfiniteTalkTab />
          </TabsContent>
          <TabsContent value="content-engine" className="mt-2">
            <ContentEngineTab />
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
