export type {
  ContentFormat,
  DriveArchiveKind,
  DriveArchiveStage,
} from './content-format'

export type DriveArchiveSourceType = 'generation' | 'discovery_item' | 'queue_job'

export interface EnqueueDriveArchiveInput {
  userId: string
  sourceType: DriveArchiveSourceType
  sourceId: string
  urls: string[]
  characterKey?: string | null
  kind: import('./content-format').DriveArchiveKind
  modelKey?: string | null
  /** Default ready — publish folder. raw = originals before repurpose. */
  stage?: import('./content-format').DriveArchiveStage | null
  /** UTC YYYY-MM-DD; defaults to today at enqueue time. */
  dateKey?: string | null
}
