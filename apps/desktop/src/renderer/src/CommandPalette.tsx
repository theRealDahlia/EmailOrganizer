import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './Icons'

export interface Command {
  id: string
  title: string
  /** where it lives, shown to the right ("Go to", "Action", "Theme") */
  group: string
  icon: string
  /** extra words that should find it */
  keywords?: string
  run: () => void
}

/** Cmd/Ctrl+K: jump to a page, run a common action, or search senders, from the keyboard. */
export function CommandPalette({ commands, onSearchSenders, onClose }: { commands: Command[]; onSearchSenders: (query: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<Element | null>(document.activeElement)

  useEffect(() => {
    input.current?.focus()
    const back = opener.current as HTMLElement | null
    return () => back?.focus?.() // put focus back where it was
  }, [])

  const results = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const found = commands.filter((c) => words.every((w) => `${c.title} ${c.group} ${c.keywords ?? ''}`.toLowerCase().includes(w)))
    const search: Command[] = query.trim()
      ? [{ id: 'search-senders', title: `Find sender “${query.trim()}”`, group: 'Search', icon: 'senders', run: () => onSearchSenders(query.trim()) }]
      : []
    return [...found, ...search]
  }, [commands, query, onSearchSenders])

  useEffect(() => setIndex(0), [query])
  useEffect(() => { document.getElementById(`cmd-${results[index]?.id}`)?.scrollIntoView({ block: 'nearest' }) }, [index, results])

  const choose = (c: Command | undefined) => { if (!c) return; onClose(); c.run() }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (results.length ? (i + 1) % results.length : 0)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[index]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'Tab') e.preventDefault() // one place to be: the box
  }

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input ref={input} role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={results[index] ? `cmd-${results[index].id}` : undefined}
            aria-label="Type a command or a sender" placeholder="Type a command, or a sender to find" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} />
          <kbd>esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" aria-label="Commands">
          {results.map((c, i) => (
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === index} className={i === index ? 'on' : undefined}
              onMouseMove={() => setIndex(i)} onMouseDown={(e) => { e.preventDefault(); choose(c) }}>
              <Icon name={c.icon} size={16} /><span>{c.title}</span><small>{c.group}</small>
            </li>
          ))}
          {results.length === 0 && <li className="none">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  )
}
