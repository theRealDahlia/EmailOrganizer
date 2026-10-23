import { mailMove, type MailAction, type MailMove } from '@organizer/core'
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
