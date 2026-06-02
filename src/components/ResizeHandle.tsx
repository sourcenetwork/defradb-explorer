import { useCallback } from 'react'
import styles from './ResizeHandle.module.css'

interface Props {
  direction: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
}

export default function ResizeHandle({ direction, onResize }: Props) {
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)

    let last         = direction === 'horizontal' ? e.clientX : e.clientY
    let rafId        = 0
    let accumulated  = 0

    function onMove(ev: PointerEvent) {
      const current = direction === 'horizontal' ? ev.clientX : ev.clientY
      accumulated += current - last
      last = current
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          onResize(accumulated)
          accumulated = 0
          rafId = 0
        })
      }
    }

    function cleanup() {
      cancelAnimationFrame(rafId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', cleanup)
      el.removeEventListener('pointercancel', cleanup)
      window.removeEventListener('pointerup', cleanup)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', cleanup)
    el.addEventListener('pointercancel', cleanup)
    window.addEventListener('pointerup', cleanup)
  }, [direction, onResize])

  return (
    <div
      className={`${styles.handle} ${direction === 'horizontal' ? styles.horizontal : styles.vertical}`}
      onPointerDown={handlePointerDown}
    >
      <div className={styles.bar} />
    </div>
  )
}
