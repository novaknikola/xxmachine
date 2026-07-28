import { getGoogleAccessToken } from './google-auth'

export interface DriveFile {
  id: string
  name: string
  createdTime?: string
  size?: string
}

async function resolveAccessToken(accessToken?: string): Promise<string> {
  return accessToken ?? getGoogleAccessToken()
}

/** Lists non-trashed files directly inside a Drive folder, optionally filtered by a mimeType prefix (e.g. 'image/'). */
export async function listDriveFiles(
  folderId: string,
  mimeTypePrefix?: string,
  accessToken?: string,
): Promise<DriveFile[]> {
  const token = await resolveAccessToken(accessToken)
  const mimeClause = mimeTypePrefix ? ` and mimeType contains '${mimeTypePrefix}'` : ''
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false${mimeClause}`)

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime,size)&orderBy=createdTime&pageSize=1000`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Drive list failed')
  return data.files ?? []
}

/** Downloads a Drive file's raw bytes. */
export async function downloadDriveFile(fileId: string, accessToken?: string): Promise<Buffer> {
  const token = await resolveAccessToken(accessToken)
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`Drive download failed: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Uploads a buffer into a Drive folder via multipart upload, returns the new file's id + a viewable link. */
export async function uploadToDriveFolder(
  folderId: string,
  filename: string,
  buffer: Buffer,
  mimeType: string,
  accessToken?: string,
): Promise<{ id: string; link: string }> {
  const token = await resolveAccessToken(accessToken)
  const boundary = `xm_${Math.random().toString(36).slice(2)}`
  const metadata = JSON.stringify({ name: filename, parents: [folderId] })

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ])

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Drive upload failed')
  return { id: data.id, link: data.webViewLink ?? `https://drive.google.com/file/d/${data.id}/view` }
}

/** Creates a Drive folder under parentId (use "root" for My Drive). */
export async function createDriveFolder(
  name: string,
  parentId: string,
  accessToken?: string,
): Promise<{ id: string; link: string }> {
  const token = await resolveAccessToken(accessToken)
  const res = await fetch(
    'https://www.googleapis.com/drive/v3/files?fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    },
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Drive create folder failed')
  return { id: data.id, link: data.webViewLink ?? `https://drive.google.com/drive/folders/${data.id}` }
}

/** Finds all direct child folders with an exact name (oldest first). */
export async function findChildFolders(
  parentId: string,
  name: string,
  accessToken?: string,
): Promise<Array<{ id: string; createdTime?: string }>> {
  const token = await resolveAccessToken(accessToken)
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const q = encodeURIComponent(
    `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${escaped}' and trashed=false`,
  )
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,createdTime)&orderBy=createdTime&pageSize=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Drive find folder failed')
  return data.files ?? []
}

/** Finds a direct child folder by exact name, or null. Prefers the oldest if duplicates exist. */
export async function findChildFolder(
  parentId: string,
  name: string,
  accessToken?: string,
): Promise<string | null> {
  const matches = await findChildFolders(parentId, name, accessToken)
  return matches[0]?.id ?? null
}

async function trashDriveFile(fileId: string, accessToken?: string): Promise<void> {
  const token = await resolveAccessToken(accessToken)
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trashed: true }),
  }).catch(() => {})
}

/**
 * Find or create a child folder under parentId.
 * Drive allows duplicate folder names, so after create we re-list and keep the
 * oldest match (trashing newer duplicates from races / search lag).
 */
export async function ensureChildFolder(
  parentId: string,
  name: string,
  accessToken?: string,
): Promise<string> {
  const existing = await findChildFolders(parentId, name, accessToken)
  if (existing.length > 0) {
    for (const dup of existing.slice(1)) {
      void trashDriveFile(dup.id, accessToken)
    }
    return existing[0]!.id
  }

  const created = await createDriveFolder(name, parentId, accessToken)

  // Drive search can lag briefly after create; re-list and dedupe.
  await new Promise(r => setTimeout(r, 400))
  const again = await findChildFolders(parentId, name, accessToken)
  if (again.length <= 1) return created.id

  const keepId = again[0]!.id
  for (const dup of again.slice(1)) {
    void trashDriveFile(dup.id, accessToken)
  }
  return keepId
}

const MULTIPART_MAX_BYTES = 4 * 1024 * 1024

/**
 * Upload preferring multipart for small files and resumable for larger ones
 * (videos). Optional accessToken uses the caller's OAuth instead of the SA.
 */
export async function uploadBufferToDriveFolder(
  folderId: string,
  filename: string,
  buffer: Buffer,
  mimeType: string,
  accessToken?: string,
): Promise<{ id: string; link: string }> {
  if (buffer.length <= MULTIPART_MAX_BYTES) {
    return uploadToDriveFolder(folderId, filename, buffer, mimeType, accessToken)
  }
  return uploadResumableToDriveFolder(folderId, filename, buffer, mimeType, accessToken)
}

async function uploadResumableToDriveFolder(
  folderId: string,
  filename: string,
  buffer: Buffer,
  mimeType: string,
  accessToken?: string,
): Promise<{ id: string; link: string }> {
  const token = await resolveAccessToken(accessToken)
  const init = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(buffer.length),
      },
      body: JSON.stringify({ name: filename, parents: [folderId] }),
    },
  )
  if (!init.ok) {
    const data = await init.json().catch(() => ({}))
    throw new Error((data as { error?: { message?: string } }).error?.message ?? `Drive resumable init failed: ${init.status}`)
  }
  const uploadUrl = init.headers.get('location')
  if (!uploadUrl) throw new Error('Drive resumable upload missing Location header')

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(buffer.length),
    },
    body: new Uint8Array(buffer),
  })
  const data = await put.json()
  if (!put.ok) throw new Error(data.error?.message ?? `Drive resumable upload failed: ${put.status}`)
  return { id: data.id, link: data.webViewLink ?? `https://drive.google.com/file/d/${data.id}/view` }
}
