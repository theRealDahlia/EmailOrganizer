import { useEffect, useRef, useState } from 'react'

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Counts a number up to its value, and on later changes from where it was (so a live scan ticks upward).
 * 600ms is longer than the 300ms motion ceiling on purpose: a count shorter than that reads as a flicker.
 */
export function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? value : 0))
  const current = useRef(shown)

  useEffect(() => {
    if (reducedMotion()) { current.current = value; setShown(value); return }
    const from = current.current
    const start = performance.now()
    let frame = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 600)
      const next = Math.round(from + (value - from) * (1 - (1 - t) ** 3))
      current.current = next
      setShown(next)
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value])

  return <>{shown.toLocaleString()}</>
}
