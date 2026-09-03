/** Meta Development-mode response when the IG account is not a Tester / has not accepted the invite. */
export const UNSUPPORTED_REQUEST_RE = /unsupported request/i

export const TESTER_REQUIRED_MESSAGE =
  'This Instagram account must be added as an Instagram Tester on the Meta app and must accept the tester invite (Instagram → Settings → Apps and websites → Tester Invites). This is not a refresh-token or HTTP-verb bug.'

export const ACCOUNT_OVERWRITE_MESSAGE =
  'Reconnect blocked: the Instagram profile that signed in does not match this account. Connect that profile as a new account instead.'

export const IG_USER_CONFLICT_MESSAGE =
  'This Instagram profile is already connected to another account on this workspace.'

export const INVALID_STATE_MESSAGE =
  'This Instagram login link expired or was already used. Start Connect again from this device.'

export function isUnsupportedRequest(message: string | null | undefined): boolean {
  return !!message && UNSUPPORTED_REQUEST_RE.test(message)
}

export function classifyMetaError(message: string | null | undefined): {
  code: string
  userMessage: string
} {
  if (isUnsupportedRequest(message)) {
    return { code: 'tester_required', userMessage: TESTER_REQUIRED_MESSAGE }
  }
  const raw = (message ?? 'instagram_error').trim() || 'instagram_error'
  return { code: 'meta_error', userMessage: raw }
}

export const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  tester_required: TESTER_REQUIRED_MESSAGE,
  account_overwrite: ACCOUNT_OVERWRITE_MESSAGE,
  ig_user_conflict: IG_USER_CONFLICT_MESSAGE,
  invalid_state: INVALID_STATE_MESSAGE,
  missing_code: 'Instagram did not return an authorization code. Try Connect again.',
  server_config:
    'Instagram App ID / Secret is not configured. Set ig_app_id and ig_app_secret in Settings, or INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET as fallback.',
  meta_error: 'Instagram connection failed. If the Meta app is in Development mode, the account must be an Instagram Tester and must accept the tester invite.',
}

export const TOKEN_STATUSES = ['active', 'refreshing', 'reconnect_required', 'expired'] as const
export type TokenStatus = (typeof TOKEN_STATUSES)[number]

export const TOKEN_STATUS_LABELS: Record<TokenStatus, string> = {
  active: 'Active',
  refreshing: 'Refreshing',
  reconnect_required: 'Reconnect required',
  expired: 'Expired',
}

export function tokenStatusLabel(status: string | null | undefined): string {
  if (status && status in TOKEN_STATUS_LABELS) return TOKEN_STATUS_LABELS[status as TokenStatus]
  return TOKEN_STATUS_LABELS.active
}

export function oauthErrorForUi(codeOrMessage: string | null): string {
  if (!codeOrMessage) return 'Instagram connection failed'
  if (OAUTH_ERROR_MESSAGES[codeOrMessage]) return OAUTH_ERROR_MESSAGES[codeOrMessage]
  if (isUnsupportedRequest(codeOrMessage)) return TESTER_REQUIRED_MESSAGE
  return codeOrMessage
}
