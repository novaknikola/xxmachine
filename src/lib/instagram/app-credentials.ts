import { getUserApiKey } from '@/lib/user-config'

export async function getInstagramAppCredentials(userId: string): Promise<{
  appId: string
  appSecret: string
}> {
  const [appId, appSecret] = await Promise.all([
    getUserApiKey(userId, 'ig_app_id'),
    getUserApiKey(userId, 'ig_app_secret'),
  ])
  return { appId, appSecret }
}
