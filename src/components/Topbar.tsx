import ConnectionBadge from './ConnectionBadge'
import styles from './Topbar.module.css'

interface Props {
  onOpenSettings: () => void
}

export default function Topbar({ onOpenSettings }: Props) {
  return (
    <header className={styles.topbar}>
      <a href="#" className={styles.logo} aria-label="DefraDB">
        <img src="/defradb-logo-white.svg" height={20} alt="DefraDB" />
        <span className={styles.fallback}>DefraDB</span>
      </a>

      <div className={styles.right}>
        <ConnectionBadge onOpenSettings={onOpenSettings} />
      </div>
    </header>
  )
}
