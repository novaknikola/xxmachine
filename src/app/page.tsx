import { getSessionUser } from '@/lib/session'
import { redirect } from 'next/navigation'
import { LandingPage } from './landing'

export default async function Home() {
  const user = await getSessionUser()
  if (user) redirect('/generate')
  return <LandingPage />
}
