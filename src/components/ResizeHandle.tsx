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

    let last = direction === 'horizontal' ? e.clientX : e.clientY

    function onMove(ev: PointerEvent) {
      const current = direction === 'horizontal' ? ev.clientX : ev.clientY
      onResize(current - last)
      last = current
    }

    function onUp() {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
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
