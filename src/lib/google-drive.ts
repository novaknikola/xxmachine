import { getGoogleAccessToken } from './google-auth'

export interface DriveFile {
  id: string
  name: string
  createdTime?: string
  size?: string
}

/** Lists non-trashed files directly inside a Drive folder, optionally filtered by a mimeType prefix (e.g. 'image/'). */
export async function listDriveFiles(folderId: string, mimeTypePrefix?: string): Promise<DriveFile[]> {
  const accessToken = await getGoogleAccessToken()
  const mimeClause = mimeTypePrefix ? ` and mimeType contains '${mimeTypePrefix}'` : ''
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false${mimeClause}`)

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime,size)&orderBy=createdTime&pageSize=1000`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Drive list failed')
  return data.files ?? []
}

/** Downloads a Drive file's raw bytes. */
export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  const accessToken = await getGoogleAccessToken()
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
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
): Promise<{ id: string; link: string }> {
  const accessToken = await getGoogleAccessToken()
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
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Drive upload failed')
  return { id: data.id, link: data.webViewLink ?? `https://drive.google.com/file/d/${data.id}/view` }
}
