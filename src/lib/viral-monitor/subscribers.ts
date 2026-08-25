import { query, rows } from '@/lib/db'

export async function addSubscriber(chatId: number): Promise<void> {
  await query(
    `INSERT INTO viral_monitor_subscribers (chat_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [chatId],
  )
}

export async function removeSubscriber(chatId: number): Promise<void> {
  await query(`DELETE FROM viral_monitor_subscribers WHERE chat_id = $1`, [chatId])
}

export async function getSubscriberChatIds(): Promise<string[]> {
  const result = await rows<{ chat_id: string }>(`SELECT chat_id FROM viral_monitor_subscribers`)
  return result.map(r => r.chat_id)
}
