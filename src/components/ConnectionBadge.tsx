import { useHealthCheck } from '../hooks/useHealthCheck'
import { useConfig } from '../context/ConfigContext'
import styles from './ConnectionBadge.module.css'

interface Props {
  onOpenSettings: () => void
}

export default function ConnectionBadge({ onOpenSettings }: Props) {
  const { config } = useConfig()
  const { data: healthy, isFetching, isError } = useHealthCheck()

  const state = isFetching && healthy === undefined ? 'checking'
    : isError || healthy === false               ? 'disconnected'
    : 'connected'

  const label = {
    checking:     'Connecting…',
    connected:    'Connected',
    disconnected: 'Disconnected',
  }[state]

  const host = (() => {
    try { return new URL(config.baseUrl).host } catch { return config.baseUrl }
  })()

  return (
    <button className={`${styles.badge} ${styles[state]}`} onClick={onOpenSettings} title="Connection settings">
      <span className={styles.dot} />
      <span className={styles.label}>{label}</span>
      <span className={styles.host}>{host}</span>
    </button>
  )
}
