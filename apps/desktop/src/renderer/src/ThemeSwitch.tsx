import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ThemePref } from '../../shared'
import { Icon } from './Icons'

const api = window.organizer

const OPTIONS: { value: ThemePref; icon: string; label: string; hint: string }[] = [
  { value: 'light', icon: 'sun', label: 'Light', hint: 'Always use the light theme' },
  { value: 'dark', icon: 'moon', label: 'Dark', hint: 'Always use the dark theme' },
  { value: 'system', icon: 'monitor', label: 'System', hint: 'Match your computer’s setting' },
]

/** Light, dark, or follow the computer. The choice is saved and applied to the whole window straight away. */
export function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>('system')
  const group = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getTheme().then(setPref, () => {})
    // the command palette can change the theme too
    const onChange = (e: Event) => setPref((e as CustomEvent<ThemePref>).detail)
    window.addEventListener('theme-changed', onChange)
    return () => window.removeEventListener('theme-changed', onChange)
  }, [])

  const choose = (next: ThemePref) => {
    const before = pref
    setPref(next) // show the change at once; go back if it could not be saved
    api.setTheme(next).then(setPref, () => setPref(before))
  }

  // Radio group keys: arrows move the choice, and the chosen option is the one that takes focus with Tab.
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = OPTIONS[(OPTIONS.findIndex((o) => o.value === pref) + step + OPTIONS.length) % OPTIONS.length].value
    choose(next)
    group.current?.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus()
  }

  return (
    <div className="theme-switch" role="radiogroup" aria-label="Color theme" ref={group} onKeyDown={onKeyDown}>
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" role="radio" data-value={o.value} aria-checked={pref === o.value} aria-label={o.label}
          title={`${o.label}: ${o.hint}`} tabIndex={pref === o.value ? 0 : -1} onClick={() => choose(o.value)}>
          <Icon name={o.icon} size={16} />
        </button>
      ))}
    </div>
  )
}
