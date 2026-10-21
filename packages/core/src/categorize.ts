import type { Category, MailMessage } from './types'

const SUBJECT_HINTS: [RegExp, Category][] = [
  [/\b(receipt|order|invoice|payment received|your purchase)\b/i, 'receipt'],
  [/\b(flight|itinerary|boarding|reservation|booking|hotel)\b/i, 'travel'],
  [/\b(statement|bill is ready|balance|transaction)\b/i, 'finance'],
  [/\b(sale|% off|deal|limited time|discount|save \d+)\b/i, 'promotion'],
]

const SOCIAL_DOMAINS = ['facebookmail.com', 'linkedin.com', 'twitter.com', 'x.com', 'instagram.com']

/** Header and keyword heuristics only. Runs locally and needs no message body. */
export function categorize(message: MailMessage): Category {
  const domain = message.from.email.split('@')[1]?.toLowerCase() ?? ''
  if (SOCIAL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return 'social'

  for (const [pattern, category] of SUBJECT_HINTS) {
    if (pattern.test(message.subject)) return category
  }

  if (message.listUnsubscribe) return 'newsletter'
  return 'personal'
}
