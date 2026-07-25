import { cn } from '@/lib/utils'

interface GlassCardProps {
  children: React.ReactNode
  className?: string
  hover?: boolean
  onClick?: () => void
}

export function GlassCard({ children, className, hover = false, onClick }: GlassCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'glass-card rounded-2xl',
        hover && 'transition-all duration-300 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/10',
        onClick && 'cursor-pointer',
        className
      )}
    >
      {children}
    </div>
  )
}
