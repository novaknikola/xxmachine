import * as React from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'

function Field({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field"
      className={cn('flex min-w-0 flex-col gap-2', className)}
      {...props}
    />
  )
}

function FieldLabel({
  className,
  ...props
}: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn('text-sm text-muted-foreground font-medium', className)}
      {...props}
    />
  )
}

function FieldHint({
  className,
  ...props
}: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-hint"
      className={cn('text-xs text-muted-foreground leading-relaxed', className)}
      {...props}
    />
  )
}

export { Field, FieldLabel, FieldHint }
