import { useEffect, useState } from 'react'
import type { ImpactSummary } from '../../shared'
import { CountUp } from './Motion'
import { formatBytes } from './format'
import { Icon, hue } from './Icons'

const api = window.organizer

type Period = 'month' | 'all'

/** What the app has done for the user: the proof that it earns its keep. Refreshes when `refreshKey` changes. */
export function ImpactCard({ refreshKey }: { refreshKey?: unknown }) {
  const [impact, setImpact] = useState<ImpactSummary | null>(null)
  const [period, setPeriod] = useState<Period>('month')

  useEffect(() => { api.impact().then(setImpact, () => {}) }, [refreshKey])
  if (!impact) return null

  const t = impact[period]
  const month = new Date().toLocaleDateString(undefined, { month: 'long' })
  const empty = impact.all.messages === 0 && impact.all.unsubscribes === 0

  return (
    <section className="card impact" style={hue(245)}>
      <div className="impact-head">
        <div>
          <h2>Your impact</h2>
          <p className="card-sub" style={{ margin: 0 }}>
            {empty ? 'Mail you clean up, and senders you unsubscribe from, add up here.' : period === 'month' ? `So far in ${month}` : 'Since you started'}
          </p>
        </div>
        <div className="seg" role="radiogroup" aria-label="Period">
          {(['month', 'all'] as Period[]).map((p) => (
            <button key={p} role="radio" aria-checked={period === p} onClick={() => setPeriod(p)}>{p === 'month' ? 'This month' : 'All time'}</button>
          ))}
        </div>
      </div>
      <div className="impact-grid">
        <div className="impact-stat"><span className="tile soft"><Icon name="check" size={17} /></span><b><CountUp value={t.messages} /></b><span className="muted">messages handled</span></div>
        <div className="impact-stat" title="Gmail frees the space once Trash is emptied, which it does on its own after 30 days.">
          <span className="tile soft"><Icon name="cleanup" size={17} /></span><b>{t.bytesTrashed > 0 ? formatBytes(t.bytesTrashed) : '0 MB'}</b><span className="muted">moved to Trash</span>
        </div>
        <div className="impact-stat"><span className="tile soft"><Icon name="clock" size={17} /></span><b><CountUp value={t.automatic} /></b><span className="muted">handled automatically</span></div>
        <div className="impact-stat"><span className="tile soft"><Icon name="bell" size={17} /></span><b><CountUp value={t.unsubscribes} /></b><span className="muted">unsubscribes</span></div>
      </div>
    </section>
  )
}
