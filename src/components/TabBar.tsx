import type { Tab } from '../types'
import styles from './TabBar.module.css'
// Tab type retained for activeTab prop used to show contextual actions

interface Props {
  activeTab:    Tab
  onNewType?:   () => void
  onPatchType?: () => void
  onNewView?:   () => void
}

const TABS_WITH_ACTIONS = new Set<Tab>(['schema'])

export default function TabBar({ activeTab, onNewType, onPatchType, onNewView }: Props) {
  if (!TABS_WITH_ACTIONS.has(activeTab)) return null
  return (
    <div className={styles.tabBar}>
      <div className={styles.actions}>
        {activeTab === 'schema' && (
          <button className={styles.btnSecondary} onClick={onPatchType}>Patch collection</button>
        )}
        {activeTab === 'schema' && (
          <button className={styles.btnSecondary} onClick={onNewView}>+ New view</button>
        )}
        {activeTab === 'schema' && (
          <button className={styles.btnPrimary} onClick={onNewType}>+ New collection</button>
        )}
      </div>
    </div>
  )
}
