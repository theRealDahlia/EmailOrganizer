import type { ReactNode } from 'react'

const paths: Record<string, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  cleanup: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></>,
  subscriptions: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  rules: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
  accounts: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></>,
  senders: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.6 3.2-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4" /><path d="M18 14.8c1.8.7 3.1 2.4 3.5 5.2" /></>,
  space: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  inbox: <><path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M3 13h5l1 3h6l1-3h5" /></>,
  unread: <><path d="M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h9" /><path d="m3 8 9 6 4-2.7" /><circle cx="19" cy="6" r="3" /></>,
  check: <><path d="m4 12 5 5L20 6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  chevron: <><path d="m6 9 6 6 6-6" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>,
  bell: <><path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z" /><path d="M10 21h4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
  moon: <><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  // a broom with a sweeping trail and two sparkles, centred; mostly filled shapes, so it reads at sidebar size
  sweep: <g transform="translate(-1.88 1.2)"><g transform="rotate(10 14.2 10.8)"><path d="M12.7 9.6 8.6 6.2" strokeWidth="1.5" /><g transform="translate(14.2 10.8) rotate(-50)" fill="currentColor" stroke="none"><rect x="-1.9" y="-1.5" width="3.8" height="1.5" rx=".5" /><path fillRule="evenodd" d="M-1.6 .5H1.6Q3.6 3.4 5 7.3Q4.3 8.3 3.6 7.6Q3 8.7 2.2 7.9Q1.5 9 .7 8.1Q0 9.2-.7 8.1Q-1.5 9-2.2 7.9Q-3 8.7-3.6 7.6Q-4.3 8.3-5 7.3Q-3.6 3.4-1.6 .5ZM-1.12 2.6L-2.82 7.2L-2.38 7.2L-0.68 2.6ZM-0.22 2.6L-0.22 7.2L0.22 7.2L0.22 2.6ZM0.68 2.6L2.38 7.2L2.82 7.2L1.12 2.6Z" /></g></g><path transform="translate(2.25 2.85) scale(.85)" d="M6.6 6.9C1.4 10 1.7 18.6 9.6 19.9 12.1 20.3 14.6 19.9 16.8 18.9 14.3 19.3 12 19.3 9.8 18.7 3.9 17.1 3.4 10.6 6.6 6.9Z" fill="currentColor" stroke="none" /><path d="M19.6 1.5Q19.6 3.6 21.7 3.6Q19.6 3.6 19.6 5.7Q19.6 3.6 17.5 3.6Q19.6 3.6 19.6 1.5z" fill="currentColor" stroke="none" /><path d="M22 6.45Q22 7.6 23.15 7.6Q22 7.6 22 8.75Q22 7.6 20.85 7.6Q22 7.6 22 6.45z" fill="currentColor" stroke="none" /></g>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M10 13h4" /></>,
}

/** One hue per page, used for its sidebar icon. */
export const PAGE_HUE: Record<string, number> = { overview: 245, space: 175, senders: 215, cleanup: 12, subscriptions: 330, activity: 155, accounts: 200 }

const CATEGORY_HUE: Record<string, number> = { personal: 245, newsletter: 270, promotion: 330, social: 200, receipt: 155, finance: 175, travel: 35 }
export const categoryHue = (name: string) => CATEGORY_HUE[name.toLowerCase()] ?? [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)

/** Inline style that sets the hue the CSS tone tokens are derived from. */
export const hue = (h: number) => ({ ['--hue' as string]: h })

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

/** Deterministic pastel avatar from a sender name. */
export function Avatar({ name }: { name: string }) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  const letter = (name.trim()[0] ?? '?').toUpperCase()
  return <span className="avatar" style={{ ['--h' as string]: h }} aria-hidden="true">{letter}</span>
}
