'use client'

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import type { CostBreakdown } from '@/lib/monitor/cost-estimate'

interface ItemLike {
  id: string
  profile: string
  content_url: string
  replicate_status: string
  replicate_error: string | null
  scene_prompt: string | null
  technique_reasoning: string | null
  video_technique: string | null
  source_duration: number | null
  generated_image_url: string | null
  generated_end_image_url: string | null
  kling_video_url: string | null
  thumbnail_url: string | null
  speech?: { transcript?: string }
  scene_spec?: {
    speech?: { transcript?: string; kind?: string }
  } | null
}

export function JobDetailSheet({
  item,
  open,
  onOpenChange,
  estimate,
  imageModelLabel,
  videoLabel,
  soundLabel,
  formatUsd,
}: {
  item: ItemLike | null
  open: boolean
  onOpenChange: (open: boolean) => void
  estimate: CostBreakdown | null
  imageModelLabel: string
  videoLabel: string
  soundLabel: string
  formatUsd: (n: number) => string
}) {
  if (!item) return null

  const transcript = item.scene_spec?.speech?.transcript

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg overflow-y-auto px-6 py-6">
        <SheetHeader className="gap-2 text-left">
          <SheetTitle>@{item.profile}</SheetTitle>
          <SheetDescription>
            Full job detail — models, cost estimate, prompts, outputs.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{item.replicate_status}</Badge>
            {item.video_technique && <Badge variant="outline">{item.video_technique}</Badge>}
            {item.source_duration != null && (
              <Badge variant="outline">{Number(item.source_duration).toFixed(1)}s</Badge>
            )}
          </div>

          <section className="space-y-2">
            <h3 className="font-medium">Pipeline</h3>
            <p className="text-muted-foreground leading-relaxed">
              {imageModelLabel} → {videoLabel} · Sound: {soundLabel}
            </p>
            {estimate && (
              <div className="rounded-lg border border-border/60 bg-secondary/30 p-4 space-y-1.5">
                <div className="flex justify-between"><span>Image</span><span className="tabular-nums">{formatUsd(estimate.imageUsd)}</span></div>
                <div className="flex justify-between"><span>Video</span><span className="tabular-nums">{formatUsd(estimate.videoUsd)}</span></div>
                <div className="flex justify-between"><span>Audio</span><span className="tabular-nums">{formatUsd(estimate.audioUsd)}</span></div>
                <div className="flex justify-between font-medium pt-1 border-t border-border/50">
                  <span>Est. total</span>
                  <span className="tabular-nums">{formatUsd(estimate.totalUsd)}</span>
                </div>
                <p className="text-xs text-muted-foreground pt-1">{estimate.note}</p>
              </div>
            )}
          </section>

          {item.technique_reasoning && (
            <section className="space-y-2">
              <h3 className="font-medium">Technique notes</h3>
              <p className="text-muted-foreground leading-relaxed">{item.technique_reasoning}</p>
            </section>
          )}

          {transcript && (
            <section className="space-y-2">
              <h3 className="font-medium">Speech</h3>
              <p className="text-muted-foreground leading-relaxed">“{transcript}”</p>
            </section>
          )}

          {item.scene_prompt && (
            <section className="space-y-2">
              <h3 className="font-medium">Scene prompt</h3>
              <pre className="whitespace-pre-wrap rounded-lg border border-border/60 bg-secondary/20 p-4 text-xs leading-relaxed text-muted-foreground max-h-64 overflow-y-auto">
                {item.scene_prompt}
              </pre>
            </section>
          )}

          {item.replicate_error && (
            <section className="space-y-2">
              <h3 className="font-medium text-destructive">Error</h3>
              <p className="text-destructive/90">{item.replicate_error}</p>
            </section>
          )}

          <section className="space-y-3">
            <h3 className="font-medium">Outputs</h3>
            <div className="flex flex-col gap-2">
              <a className="text-primary hover:underline" href={item.content_url} target="_blank" rel="noopener noreferrer">
                Source post
              </a>
              {item.generated_image_url && (
                <a className="text-primary hover:underline" href={item.generated_image_url} target="_blank" rel="noopener noreferrer">
                  Generated image
                </a>
              )}
              {item.generated_end_image_url && (
                <a className="text-primary hover:underline" href={item.generated_end_image_url} target="_blank" rel="noopener noreferrer">
                  End frame
                </a>
              )}
              {item.kling_video_url && (
                <a className="text-primary hover:underline" href={item.kling_video_url} target="_blank" rel="noopener noreferrer">
                  Generated video
                </a>
              )}
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
