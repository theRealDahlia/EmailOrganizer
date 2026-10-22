/** Google OAuth 2.0 for installed apps: authorization code flow with PKCE. Network and UI are injected. */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  // Used only to read the storage quota (Drive API about.get); it grants no access to the user's Drive files.
  'https://www.googleapis.com/auth/drive.appdata',
]

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /** epoch ms */
  expiresAt: number
}

/** The refresh token was revoked or expired; the user must sign in again. */
export class AuthExpiredError extends Error {
  constructor() {
    super('Google sign-in expired. Reconnect your account.')
    this.name = 'AuthExpiredError'
  }
}

type FetchLike = typeof fetch

function base64Url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomToken(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64Url(new Uint8Array(digest)) }
}

export function buildAuthUrl(p: {
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  scopes?: string[]
}): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: (p.scopes ?? GMAIL_SCOPES).join(' '),
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    access_type: 'offline', // request a refresh token
    prompt: 'consent', // always return a refresh token, even on re-connect
  })
  return `${GOOGLE_AUTH_URL}?${q}`
}

async function tokenRequest(body: Record<string, string>, fetchImpl: FetchLike) {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!res.ok || !json.access_token) {
    if (json.error === 'invalid_grant') throw new AuthExpiredError()
    throw new Error(`Google token request failed: ${json.error_description ?? json.error ?? res.status}`)
  }
  return json as Required<Pick<typeof json, 'access_token' | 'expires_in'>> & typeof json
}

export async function exchangeCode(
  p: OAuthClient & { code: string; verifier: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<TokenSet> {
  const t = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      client_secret: p.clientSecret,
    },
    fetchImpl,
  )
  if (!t.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.')
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now + t.expires_in * 1000 }
}

export async function refreshTokens(
  client: OAuthClient,
  tokens: TokenSet,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<TokenSet> {
  const t = await tokenRequest(
    {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    fetchImpl,
  )
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? tokens.refreshToken, // Google usually omits it on refresh
    expiresAt: now + t.expires_in * 1000,
  }
}

export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await fetchImpl(GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined) // best effort; local credentials are deleted regardless
}

const EXPIRY_SKEW_MS = 60_000

/** Hands out a valid access token, refreshing when needed and reporting new tokens for persistence. */
export class GoogleTokenSource {
  private refreshing: Promise<TokenSet> | null = null

  constructor(
    private client: OAuthClient,
    private tokens: TokenSet,
    private onUpdate: (t: TokenSet) => void,
    private fetchImpl: FetchLike = fetch,
    private clock: () => number = Date.now,
  ) {}

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.tokens.expiresAt - EXPIRY_SKEW_MS > this.clock()) return this.tokens.accessToken
    this.refreshing ??= refreshTokens(this.client, this.tokens, this.fetchImpl, this.clock()).finally(() => {
      this.refreshing = null
    })
    this.tokens = await this.refreshing
    this.onUpdate(this.tokens)
    return this.tokens.accessToken
  }
}
