import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractDriveFileId } from './bulk-sheet'

describe('extractDriveFileId', () => {
  it('parses a standard /file/d/<id>/view link', () => {
    assert.equal(
      extractDriveFileId('https://drive.google.com/file/d/1AbC-xyz_123/view?usp=sharing'),
      '1AbC-xyz_123',
    )
  })

  it('parses an /open?id=<id> link', () => {
    assert.equal(extractDriveFileId('https://drive.google.com/open?id=1AbC-xyz_123'), '1AbC-xyz_123')
  })

  it('parses a /uc?id=<id>&export=download link', () => {
    assert.equal(
      extractDriveFileId('https://drive.google.com/uc?id=1AbC-xyz_123&export=download'),
      '1AbC-xyz_123',
    )
  })

  it('accepts a bare file id typed directly', () => {
    assert.equal(extractDriveFileId('1AbC-xyz_123456'), '1AbC-xyz_123456')
  })

  it('returns null for empty or unrecognized input', () => {
    assert.equal(extractDriveFileId(''), null)
    assert.equal(extractDriveFileId('   '), null)
    assert.equal(extractDriveFileId('https://example.com/not-a-drive-link'), null)
  })
})
