export interface ScannedVideo {
  shortcode: string
  url: string
  views: number
  postedAt: string | null
  profileUsername: string
  followers: number | null
}

export interface RunSummary {
  // viral_monitor_runs.id is bigserial — node-postgres returns bigint/bigserial as strings.
  runId: string
  status: 'done' | 'failed'
  profilesTotal: number
  profilesFailed: number
  videosScanned: number
  videosNew: number
  viralNew: number
  error?: string
}
