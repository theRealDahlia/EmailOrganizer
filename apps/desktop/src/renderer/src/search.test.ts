import { describe, expect, it } from 'vitest'
import { searchMatcher } from './search'

const finds = (query: string, text: string) => searchMatcher(query)(text)

describe('searchMatcher', () => {
  const SENDER = 'Oscar’s Eats oscarseats@mail.example.com'

  it('finds a name typed without the apostrophe, or with a plural or singular slip', () => {
    for (const q of ['Oscar Eats', 'Oscars Eats', 'Oscars Eat', 'Oscar Eat', 'Oscar\'s Eats', 'Oscar’s Eats', 'oscar eat', 'OSCAR\'S EATS']) {
      expect(finds(q, SENDER), q).toBe(true)
    }
  })

  it('finds on part of a word, in any order, and with the spaces missing', () => {
    for (const q of ['osc', 'oscars', 'eats', 'eats oscar', 'scar eat', 'oscarseats', 'oscar seats']) {
      expect(finds(q, SENDER), q).toBe(true)
    }
  })

  it('does not find something that is a different name', () => {
    for (const q of ['Oscar Pizza', 'Oscar’s Burgers', 'xyz', 'Eats Oscar Jr']) expect(finds(q, SENDER), q).toBe(false)
  })

  it('searches the address too, in whole or in part', () => {
    const text = 'Site Monitors alerts@sitemonitors.example'
    for (const q of ['alerts@sitemonitors.example', 'sitemon', 'sitemonitors.example', 'monitors', 'alerts example']) expect(finds(q, text), q).toBe(true)
    expect(finds('alerts@other.example', text)).toBe(false)
  })

  it('ignores accents and case', () => {
    expect(finds('cafe', 'Café Oscar')).toBe(true)
    expect(finds('CAFÉ', 'cafe oscar')).toBe(true)
  })

  it('works for names that aren’t written in Latin letters', () => {
    expect(finds('寿司', '寿司屋 sushi@example.jp')).toBe(true)
    expect(finds('ラーメン', '寿司屋 sushi@example.jp')).toBe(false)
  })

  it('matches everything for an empty or punctuation-only search', () => {
    expect(finds('', SENDER)).toBe(true)
    expect(finds('   ', SENDER)).toBe(true)
    expect(finds(' ’ ', SENDER)).toBe(true)
  })

  it('treats words of three letters or fewer as they are, so short names still mean something', () => {
    expect(finds('bus', 'Bus Co bus@x.com')).toBe(true)
    expect(finds('bus', 'Buses Inc')).toBe(true) // prefix of a word
    expect(finds('xs', 'Bus Co')).toBe(false)
  })
})
