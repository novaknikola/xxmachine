'use client'

interface SparklineProps {
  values: number[]
  className?: string
  height?: number
  strokeWidth?: number
  fill?: boolean
}

export function Sparkline({
  values,
  className = 'w-full h-8 text-cyan-accent',
  height = 32,
  strokeWidth = 1.5,
  fill = true,
}: SparklineProps) {
  if (!values.length) return null
  const width = 100 // viewBox unit; preserveAspectRatio="none" lets it stretch
  if (values.length === 1) {
    const y = height / 2
    return (
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={className}>
        <line x1={0} y1={y} x2={width} y2={y} stroke="currentColor" strokeWidth={strokeWidth} strokeOpacity={0.5} />
      </svg>
    )
  }
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width
    const y = height - ((v - min) / range) * height
    return [x, y] as const
  })
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ')
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={className}>
      {fill && (
        <path d={areaPath} fill="currentColor" fillOpacity={0.12} />
      )}
      <path d={linePath} fill="none" stroke="currentColor" strokeWidth={strokeWidth} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
