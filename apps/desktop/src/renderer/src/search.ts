const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
const wordsOf = (s: string) => fold(s).replace(/['’`´]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const compact = (s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, '')
/** "eats" and "eat", "Oscar's" and "Oscars" should be the same word to someone typing a name from memory. */
const stem = (w: string) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)

/**
 * A forgiving test for "does this text match what the user typed". Case, accents and apostrophes don't matter, a plural
 * or a possessive matches the plain word, word order doesn't matter, every word only has to appear inside one of the
 * text's words (so "osc" finds "Oscar's"), and spaces can be missing or extra ("oscarseats").
 * Searching "Oscar Eats", "Oscars Eats" or "Oscars Eat" all find "Oscar's Eats".
 * An empty search matches everything.
 */
export function searchMatcher(query: string): (text: string) => boolean {
  const wanted = wordsOf(query).map(stem)
  if (wanted.length === 0) return () => true
  const wantedCompact = compact(query)
  return (text) => {
    const have = wordsOf(text).map(stem)
    if (wanted.every((w) => have.some((h) => h.includes(w)))) return true
    return compact(text).includes(wantedCompact)
  }
}
