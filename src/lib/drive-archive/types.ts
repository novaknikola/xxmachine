export type {
  ContentFormat,
  DriveArchiveKind,
  DriveArchiveStage,
} from './content-format'

export type DriveArchiveSourceType =
  | 'generation'
  | 'discovery_item'
  | 'queue_job'
  /** Pins saved straight to stories from an imported board — no generation involved. */
  | 'pinterest_pin'

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
  /** See buildArchiveFilename — groups independent calls (e.g. carousel slides) into one ordered set. */
  seriesId?: string | null
  seriesIndex?: number | null
  /** @deprecated No longer read — a seriesId plus a seriesIndex is what makes a series. */
  seriesTotal?: number | null
  /**
   * User-chosen base name. Replaces the machine-generated filename prefix.
   * Absent or blank keeps today's automatic name, unchanged.
   */
  seriesLabel?: string | null
  /**
   * Subfolder under the date folder, one per set (e.g. one carousel).
   * Persisted on the row because the Drive worker resolves the folder later and
   * only ever sees drive_exports columns.
   */
  seriesFolder?: string | null
}
