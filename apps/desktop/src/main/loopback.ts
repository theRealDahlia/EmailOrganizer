import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface LoopbackListener {
  redirectUri: string
  /** Resolves with the authorization code once Google redirects back. */
  code: Promise<string>
  close(): void
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em"><h2>${title}</h2><p>${body}</p></body>`

/**
 * One-shot HTTP server on 127.0.0.1 (random port) that receives the OAuth redirect.
 * Only accepts the redirect carrying the expected `state`, so stray requests can't inject a code.
 */
export function listenForAuthCode(expectedState: string, timeoutMs = 5 * 60_000): Promise<LoopbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let settle!: { resolve: (c: string) => void; reject: (e: Error) => void }
    const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject } })
    code.catch(() => undefined) // avoid unhandled rejection if nobody awaits after close()

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/') { res.writeHead(404).end(); return }

      const respond = (status: number, title: string, body: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(PAGE(title, body))
      }

      if (url.searchParams.get('state') !== expectedState) {
        respond(400, 'Invalid request', 'This sign-in response did not match the request. Please try again from the app.')
        return
      }
      const error = url.searchParams.get('error')
      const authCode = url.searchParams.get('code')
      if (error || !authCode) {
        respond(400, 'Sign-in cancelled', 'You can close this tab and return to Email Organizer.')
        settle.reject(new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Google sign-in failed: ${error ?? 'no code returned'}`))
        return
      }
      respond(200, 'Connected', 'You can close this tab and return to Email Organizer.')
      settle.resolve(authCode)
    })

    const timer = setTimeout(() => settle.reject(new Error('Sign-in timed out. Please try again.')), timeoutMs)
    const close = () => { clearTimeout(timer); server.close(); server.closeAllConnections() }
    code.then(close, close)

    server.once('error', rejectListener)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolveListener({ redirectUri: `http://127.0.0.1:${port}`, code, close })
    })
  })
}
