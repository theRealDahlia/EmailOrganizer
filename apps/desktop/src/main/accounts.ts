import { shell } from 'electron'
import {
  AuthExpiredError, DemoProvider, GmailProvider, GoogleTokenSource, buildAuthUrl, createPkce,
  exchangeCode, randomToken, revokeToken, type MailProvider, type OAuthClient, type TokenSet,
} from '@organizer/core'
import type { AccountStatus } from '../shared'
import { listenForAuthCode } from './loopback'
import type { SecretStore } from './secrets'

/** OAuth client shipped with the app (set in apps/desktop/.env at build time). Google treats installed-app secrets as non-confidential. */
const BUNDLED: OAuthClient | null =
  import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID && import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET
    ? { clientId: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID, clientSecret: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET }
    : null

const K = { clientId: 'google.clientId', clientSecret: 'google.clientSecret', tokens: 'google.tokens', email: 'google.email' }

/** Owns which mailbox the app is looking at: a connected Gmail account, or the built-in demo. */
export class AccountManager {
  private demo = new DemoProvider()
  private gmail: GmailProvider | null = null
  private tokenSource: GoogleTokenSource | null = null

  constructor(private secrets: SecretStore) {
    this.restore()
  }

  provider(): MailProvider {
    return this.gmail ?? this.demo
  }

  status(): AccountStatus {
    return {
      mode: this.gmail ? 'gmail' : 'demo',
      email: this.secrets.get(K.email) ?? undefined,
      bundledClient: !!BUNDLED,
      hasCredentials: !!this.client(),
      secureStorage: this.secrets.available,
    }
  }

  saveCredentials(clientId: string, clientSecret: string): void {
    const id = clientId.trim()
    const secret = clientSecret.trim()
    if (!id.endsWith('.apps.googleusercontent.com')) throw new Error('That doesn\'t look like a Google client ID (it should end in .apps.googleusercontent.com).')
    if (!secret) throw new Error('Enter the client secret.')
    this.secrets.set(K.clientId, id)
    this.secrets.set(K.clientSecret, secret)
  }

  async connect(): Promise<void> {
    const client = this.client()
    if (!client) throw new Error('This build has no Google client configured. Add one under Advanced, or see docs/GOOGLE_SETUP.md.')

    const { verifier, challenge } = await createPkce()
    const state = randomToken(16)
    const listener = await listenForAuthCode(state)
    try {
      await shell.openExternal(buildAuthUrl({ clientId: client.clientId, redirectUri: listener.redirectUri, challenge, state }))
      const code = await listener.code
      const tokens = await exchangeCode({ ...client, code, verifier, redirectUri: listener.redirectUri })
      const email = await this.build(client, tokens).getProfileEmail()

      this.secrets.set(K.tokens, JSON.stringify(tokens))
      this.secrets.set(K.email, email)
      this.gmail = this.build(client, tokens, email) // the provider's accountId must be the real address
    } finally {
      listener.close()
    }
  }

  async disconnect(): Promise<void> {
    const raw = this.secrets.get(K.tokens)
    if (raw) await revokeToken((JSON.parse(raw) as TokenSet).refreshToken)
    this.secrets.delete(K.tokens, K.email)
    this.gmail = null
    this.tokenSource = null
  }

  isAuthError(e: unknown): boolean {
    return e instanceof AuthExpiredError
  }

  /** A client the user saved under Advanced wins over the one bundled with the app. */
  private client(): OAuthClient | null {
    const clientId = this.secrets.get(K.clientId)
    const clientSecret = this.secrets.get(K.clientSecret)
    return clientId && clientSecret ? { clientId, clientSecret } : BUNDLED
  }

  private restore(): void {
    const client = this.client()
    const raw = this.secrets.get(K.tokens)
    const email = this.secrets.get(K.email)
    if (!client || !raw || !email) return
    this.gmail = this.build(client, JSON.parse(raw) as TokenSet, email)
  }

  private build(client: OAuthClient, tokens: TokenSet, email = 'pending'): GmailProvider {
    this.tokenSource = new GoogleTokenSource(client, tokens, (t) => this.secrets.set(K.tokens, JSON.stringify(t)))
    const source = this.tokenSource
    return new GmailProvider({ accountId: email, getAccessToken: (force) => source.getAccessToken(force) })
  }
}
