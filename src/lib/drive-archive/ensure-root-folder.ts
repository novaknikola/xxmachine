import { createDriveFolder, findChildFolder } from '@/lib/google-drive'

const ROOT_FOLDER_NAME = 'XXMachine Archives'

/** Create or find the user's archive root folder in their My Drive. */
export async function ensureDriveRootFolder(accessToken: string): Promise<string> {
  const existing = await findChildFolder('root', ROOT_FOLDER_NAME, accessToken)
  if (existing) return existing
  const created = await createDriveFolder(ROOT_FOLDER_NAME, 'root', accessToken)
  return created.id
}
