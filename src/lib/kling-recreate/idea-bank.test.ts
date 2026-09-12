import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterNewIdeas, ideaUniquenessHash, type IdeaCandidate } from './ideas'

describe('ideaUniquenessHash', () => {
  it('normalizes whitespace and case so near-copies collide', () => {
    const a = ideaUniquenessHash('  A woman walks toward camera.  ')
    const b = ideaUniquenessHash('a woman walks toward camera.')
    const c = ideaUniquenessHash('A woman  walks   toward camera.')
    assert.equal(a, b)
    assert.equal(a, c)
    assert.notEqual(a, ideaUniquenessHash('A woman runs toward camera.'))
  })
})

describe('idea-bank dedupe', () => {
  it('drops prompts the user already has and dupes inside the batch', () => {
    const existing = new Set([ideaUniquenessHash('already banked idea')])
    const incoming: IdeaCandidate[] = [
      { niche: 'girl-next-door', prompt: 'Already banked idea' },
      { niche: 'goth-girl', prompt: 'Brand new rooftop idea' },
      { niche: 'coquette', prompt: 'brand new rooftop idea' },
      { niche: 'lux-glam', prompt: 'A third unique idea' },
      { niche: 'y2k', prompt: '   ' },
    ]
    const kept = filterNewIdeas(incoming, existing)
    assert.equal(kept.length, 2)
    assert.deepEqual(kept.map(i => i.niche), ['goth-girl', 'lux-glam'])
    assert.equal(kept[0].hash, ideaUniquenessHash('Brand new rooftop idea'))
  })

  it('simulates unique (user_id, hash) so a second insert is a no-op', () => {
    const store = new Map<string, { userId: string; hash: string; prompt: string }>()
    function insert(userId: string, prompt: string): 'inserted' | 'duplicate' {
      const hash = ideaUniquenessHash(prompt)
      const key = `${userId}:${hash}`
      if (store.has(key)) return 'duplicate'
      store.set(key, { userId, hash, prompt })
      return 'inserted'
    }

    assert.equal(insert('u1', 'Same idea'), 'inserted')
    assert.equal(insert('u1', 'same idea'), 'duplicate')
    assert.equal(insert('u2', 'Same idea'), 'inserted')
    assert.equal(store.size, 2)
  })
})
