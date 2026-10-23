import { mailMove, type MailAction, type MailMove } from '@organizer/core'
import type { UnsubscribeRecord } from '../../shared'
import { Icon } from './Icons'

const MOVES: Record<MailMove, { icon: string; short: string; long: string; hint: string }> = {
  trash: { icon: 'cleanup', short: 'To Trash', long: 'Moves mail to Trash', hint: 'Mail leaves the inbox and goes to Trash. Gmail keeps it for 30 days, so you can undo.' },
  archive: { icon: 'archive', short: 'Out of inbox', long: 'Moves mail out of the inbox', hint: 'Mail leaves the inbox but stays in All Mail and in search.' },
}

/** Marks an action that moves mail out of the inbox, so it stands out from ones that only label or mark mail. */
export function MoveChip({ move, long }: { move: MailMove; long?: boolean }) {
  const m = MOVES[move]
  return (
    <span className={`move-chip ${move}`} title={m.hint}>
      <Icon name={m.icon} size={12} />{long ? m.long : m.short}
    </span>
  )
}

/** The chip for a list of actions, or nothing when none of them moves mail. */
export function MoveChips({ actions, long }: { actions: MailAction[]; long?: boolean }) {
  const move = mailMove(actions)
  return move ? <MoveChip move={move} long={long} /> : null
}

/** Where an unsubscribe stands: sent, confirmed to have worked, or ignored by the sender (so their mail is archived). */
export function UnsubStatus({ record }: { record: UnsubscribeRecord }) {
  const day = new Date(record.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (record.status === 'worked') return <span className="pill ok" title={`No mail from them since a week after you unsubscribed on ${day}.`}>Unsubscribed · they stopped</span>
  if (record.status === 'still_sending') {
    return <span className="pill warn" title="They kept sending after you unsubscribed, so the app now archives their mail automatically. See Cleanup.">Still sending · now auto-archived</span>
  }
  return <span className="pill scanned" title="The app checks a week later whether they stopped.">Unsubscribed {day} · checking in a week</span>
}
