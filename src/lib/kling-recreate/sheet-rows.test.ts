import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  KLING_ANALYSIS_HEADERS,
  KLING_IDEA_HEADERS,
  buildAnalysisSheetRow,
  buildIdeaSheetRow,
  existingIdeaHashes,
  findAnalysisRowNumber,
  ideasNotAlreadyInSheet,
  instagramShortcode,
  matchViralRow,
  urlsShareShortcode,
  viralFieldsFromRow,
  type ViralLookupRow,
} from './sheet-rows'
import { ideaUniquenessHash } from './ideas'

describe('instagram shortcode matching', () => {
  it('treats /reel/ and /p/ as the same shortcode', () => {
    assert.equal(
      instagramShortcode('https://www.instagram.com/reel/AbC123xyz/'),
      instagramShortcode('https://instagram.com/p/AbC123xyz/?igsh=1'),
    )
    assert.ok(urlsShareShortcode(
      'https://www.instagram.com/reel/AbC123xyz/',
      'https://instagram.com/p/AbC123xyz/',
    ))
  })

  it('matches username-prefixed reel paths and /reels/', () => {
    assert.ok(urlsShareShortcode(
      'https://www.instagram.com/someone/reel/AbC123xyz/',
      'https://www.instagram.com/reels/AbC123xyz',
    ))
  })

  it('does not invent a match across different shortcodes', () => {
    assert.equal(
      urlsShareShortcode(
        'https://www.instagram.com/reel/AAAA11111/',
        'https://www.instagram.com/p/BBBB22222/',
      ),
      false,
    )
    assert.equal(instagramShortcode('https://example.com/not-ig'), null)
  })

  it('matches a viral_monitor row by shortcode column or video_url', () => {
    const rows: ViralLookupRow[] = [
      {
        profile_username: 'other',
        video_url: 'https://www.instagram.com/reel/NOPE00000/',
        shortcode: 'NOPE00000',
        last_views: 9,
        reported_at: null,
      },
      {
        profile_username: 'star',
        video_url: 'https://www.instagram.com/p/HitReel99/',
        shortcode: null,
        last_views: 250000,
        reported_at: '2026-09-01T00:00:00Z',
      },
    ]
    const hit = matchViralRow('https://instagram.com/reel/HitReel99/', rows)
    assert.equal(hit?.profile_username, 'star')
    assert.deepEqual(viralFieldsFromRow(hit!), {
      profile: 'star',
      views: '250000',
      viral: 'YES',
    })
    assert.equal(matchViralRow('https://instagram.com/reel/Missing99/', rows), null)
    assert.deepEqual(viralFieldsFromRow(null), { profile: '', views: '', viral: '' })
  })
})

describe('Kling Analysis row mapping', () => {
  it('writes 16 columns in header order and keeps blanks blank', () => {
    assert.equal(KLING_ANALYSIS_HEADERS.length, 16)
    const row = buildAnalysisSheetRow({
      jobId: 'job-1',
      addedAt: '2026-09-12T07:00:00.000Z',
      sourceUrl: 'https://www.instagram.com/reel/AbC123xyz/',
      viral: { profile: 'star', views: '120000', viral: 'YES' },
      durationSec: 8.4,
      context: {
        setting: 'kitchen',
        character_action: 'pours coffee',
        camera: 'handheld',
        speech: 'want some?',
        prompt_mode: 'multi_prompt',
        shots: [
          { t_start: 0, t_end: 4, prompt: 'pour' },
          { t_start: 4, t_end: 8, prompt: 'sip' },
        ],
      },
      masterPrompt: 'A woman pours coffee then sips.',
      status: 'analyzing',
      klingVideoUrl: null,
    })
    assert.equal(row.length, 16)
    assert.deepEqual(row, [
      'job-1',
      '2026-09-12T07:00:00.000Z',
      'https://www.instagram.com/reel/AbC123xyz/',
      'star',
      '120000',
      'YES',
      '8.4',
      'kitchen',
      'pours coffee',
      'handheld',
      'want some?',
      'A woman pours coffee then sips.',
      'multi_prompt',
      '0-4s: pour | 4-8s: sip',
      'analyzing',
      '',
    ])
  })

  it('finds an existing Job ID row without treating the header as data', () => {
    const values = [
      [...KLING_ANALYSIS_HEADERS],
      ['job-a', 't1'],
      ['job-b', 't2'],
    ]
    assert.equal(findAnalysisRowNumber(values, 'job-b'), 3)
    assert.equal(findAnalysisRowNumber(values, 'Job ID'), null)
    assert.equal(findAnalysisRowNumber(values, 'missing'), null)
  })
})

describe('Kling Ideas row mapping', () => {
  it('maps columns and leaves Used/Notes empty', () => {
    assert.equal(KLING_IDEA_HEADERS.length, 10)
    const hash = ideaUniquenessHash('Rooftop golden hour walk')
    const row = buildIdeaSheetRow({
      addedAt: '2026-09-12T07:00:00.000Z',
      idea: { niche: 'girl-next-door', prompt: 'Rooftop golden hour walk', hash },
      sourceUrl: 'https://www.instagram.com/reel/AbC123xyz/',
      viral: { profile: 'star', views: '120000', viral: 'YES' },
      jobId: 'job-1',
    })
    assert.equal(row.length, 10)
    assert.equal(row[0], '2026-09-12T07:00:00.000Z')
    assert.equal(row[1], 'girl-next-door')
    assert.equal(row[2], 'Rooftop golden hour walk')
    assert.equal(row[3], 'https://www.instagram.com/reel/AbC123xyz/')
    assert.equal(row[4], 'YES')
    assert.equal(row[5], '120000')
    assert.equal(row[6], 'job-1')
    assert.equal(row[7], hash)
    assert.equal(row[8], '')
    assert.equal(row[9], '')
    assert.equal(KLING_IDEA_HEADERS[8], 'Used')
    assert.equal(KLING_IDEA_HEADERS[9], 'Notes')
  })

  it('dedupes by Hash so retries do not append again', () => {
    const keep = { niche: 'goth-girl', prompt: 'new idea', hash: 'aaa' }
    const values = [
      [...KLING_IDEA_HEADERS],
      ['t', 'n', 'p', 'u', '', '', 'job', 'aaa', 'x', 'keep me'],
    ]
    const hashes = existingIdeaHashes(values)
    assert.ok(hashes.has('aaa'))
    const fresh = ideasNotAlreadyInSheet(
      [keep, { niche: 'y2k', prompt: 'other', hash: 'bbb' }],
      hashes,
    )
    assert.deepEqual(fresh.map(i => i.hash), ['bbb'])
  })
})
