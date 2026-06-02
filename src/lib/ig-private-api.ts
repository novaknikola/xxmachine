// eslint-disable-next-line @typescript-eslint/no-require-imports
const { IgApiClient } = require('instagram-private-api')
import { one } from '@/lib/db'

export async function getIgClient(accountId: string) {
  const acc = await one<{
    ig_username: string | null
    ig_session: object | null
    proxy_url: string | null
  }>(`SELECT ig_username, ig_session, proxy_url FROM instagram_accounts WHERE id=$1`, [accountId])

  if (!acc) throw new Error(`Account not found: ${accountId}`)

  const session = acc.ig_session as Record<string, unknown> | null
  const isBrowserSession = !!session && typeof session.sessionid === 'string'

  if (!acc.ig_username && !isBrowserSession) {
    throw new Error('Account has no ig_username — import credentials first')
  }

  const ig = new IgApiClient()
  // Browser sessions use dsUserId as device seed when username isn't set yet
  ig.state.generateDevice(acc.ig_username || (session?.dsUserId as string) || accountId)

  if (acc.proxy_url) {
    ig.state.proxyUrl = acc.proxy_url
  }

  if (session) {
    if (isBrowserSession) {
      // Browser-captured session: inject cookies into ig cookie jar.
      // Must use Domain=.instagram.com so cookies apply to i.instagram.com
      // (where instagram-private-api sends all API requests), not just www.
      const cookies = session.cookies as Array<{ name: string; value: string; domain?: string; path?: string }>
      for (const c of cookies ?? []) {
        try {
          const domain = (c.domain ?? '.instagram.com').startsWith('.')
            ? c.domain : `.${c.domain ?? 'instagram.com'}`
          await ig.state.cookieJar.setCookie(
            `${c.name}=${c.value}; Domain=${domain}; Path=${c.path ?? '/'}`,
            'https://www.instagram.com'
          )
        } catch { /* ignore malformed cookies */ }
      }
    } else {
      await ig.state.deserialize(acc.ig_session)
    }
  }

  return ig
}

export async function saveIgSession(accountId: string, ig: typeof IgApiClient.prototype) {
  const session = await ig.state.serialize()
  delete session.constants
  await one(
    `UPDATE instagram_accounts SET ig_session=$1 WHERE id=$2`,
    [JSON.stringify(session), accountId]
  )
}

export async function loginIgClient(
  ig: typeof IgApiClient.prototype,
  username: string,
  password: string,
  totpSecret?: string | null
) {
  await ig.simulate.preLoginFlow()

  let loggedInUser
  try {
    loggedInUser = await ig.account.login(username, password)
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err) {
      const name = (err as { name: string }).name
      if (name === 'IgCheckpointError') {
        await ig.challenge.auto(true)
        throw Object.assign(new Error('CHECKPOINT'), { checkpoint: true })
      }
      if (name === 'IgLoginTwoFactorRequiredError') {
        if (!totpSecret) throw new Error('2FA required but no TOTP secret provided')
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { authenticator } = require('otplib')
        const twoFactorCode = authenticator.generate(totpSecret)
        const twoFactorInfo = (err as { response?: { body?: { two_factor_info?: { two_factor_identifier?: string } } } })
          .response?.body?.two_factor_info
        loggedInUser = await ig.account.twoFactorLogin({
          username,
          verificationCode: twoFactorCode,
          twoFactorIdentifier: twoFactorInfo?.two_factor_identifier ?? '',
          verificationMethod: '0',
          trustThisDevice: '1',
        })
      } else {
        throw err
      }
    } else {
      throw err
    }
  }

  await ig.simulate.postLoginFlow()
  return loggedInUser
}
