export interface UnsubscribeTargets {
  https?: string
  mailto?: string
}

/** Parses a List-Unsubscribe header (RFC 2369): comma-separated <uri> entries. */
export function parseListUnsubscribe(header: string): UnsubscribeTargets {
  const out: UnsubscribeTargets = {}
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const uri = m[1].trim()
    if (/^https:\/\//i.test(uri) && isPublicHttpsUrl(uri)) out.https ??= uri
    else if (/^mailto:/i.test(uri)) out.mailto ??= uri
  }
  return out
}

/**
 * Unsubscribe links come from untrusted email, so only allow https to public hosts.
 * Blocks localhost, private/link-local ranges, and bare IPs that could reach local services.
 */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host.startsWith('[') || host.includes(':')) return false // IPv6 literals
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false // IPv4 literals
  return host.includes('.')
}
