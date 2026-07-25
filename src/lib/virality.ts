export interface ViralityInput {
  views:    number
  likes:    number
  comments: number
  followers: number
  postedAt: Date
}

export function calculateViralityScore(i: ViralityInput): number {
  const followers = Math.max(1, i.followers)
  const views     = Math.max(0, i.views)
  const likes     = Math.max(0, i.likes)
  const comments  = Math.max(0, i.comments)

  const ageDays   = (Date.now() - i.postedAt.getTime()) / 86_400_000
  const viewRate  = views / followers
  const likeRate  = views > 0 ? likes    / views : 0
  const commentRate = views > 0 ? comments / views : 0
  const velocity  = calculateVelocity(views, i.postedAt)
  const recency   = Math.max(0, 1 - ageDays / 14)

  const score = viewRate    * 50
              + likeRate    * 25
              + commentRate * 10
              + Math.min(velocity / 1000, 1) * 10
              + recency     * 5

  return Math.round(score * 100) / 100
}

export function calculateVelocity(views: number, postedAt: Date): number {
  const hoursSince = Math.max(1, (Date.now() - postedAt.getTime()) / 3_600_000)
  return Math.round(views / hoursSince)
}
