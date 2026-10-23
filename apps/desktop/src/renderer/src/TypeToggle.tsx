/** Switches a new rule between the Gmail-search form and the sort-by-type form. Offered only on a blank new rule. */
export interface TypeToggleProps {
  checked: boolean
  /** `name` is whatever has been typed so far, so switching forms doesn't lose it */
  onChange: (checked: boolean, name: string) => void
}

export function TypeToggle({ toggle, name }: { toggle: TypeToggleProps; name: string }) {
  return (
    <div className="type-toggle">
      <b>Want to catch receipts, travel or newsletters?</b>
      <label className="inline">
        <input type="checkbox" checked={toggle.checked} onChange={(e) => toggle.onChange(e.target.checked, name)} />
        <span>Use scanned mail <span className="muted">to sort by type of email. It only sees mail the app has already downloaded.</span></span>
      </label>
    </div>
  )
}
