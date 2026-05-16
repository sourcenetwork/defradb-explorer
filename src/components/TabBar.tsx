import type { Tab } from '../types'
import styles from './TabBar.module.css'

interface Props {
  activeTab:      Tab
  onTabChange:    (tab: Tab) => void
  onNewDocument?: () => void
  onExport?:      () => void
  onNewType?:     () => void
  onPatchType?:   () => void
  onNewView?:     () => void
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'collections', label: 'Collections' },
  { id: 'query',       label: 'Query Runner' },
  { id: 'schema',      label: 'Schema' },
  { id: 'commits',     label: 'Commits' },
]

export default function TabBar({ activeTab, onTabChange, onNewDocument, onExport, onNewType, onPatchType, onNewView }: Props) {
  return (
    <div className={styles.tabBar}>
      {TABS.map(t => (
        <button
          key={t.id}
          className={`${styles.tab} ${activeTab === t.id ? styles.active : ''}`}
          onClick={() => onTabChange(t.id)}
        >
          {t.label}
        </button>
      ))}
      <div className={styles.actions}>
        {activeTab === 'collections' && (
          <button className={styles.btnSecondary} onClick={onExport}>Export</button>
        )}
        {activeTab === 'collections' && (
          <button className={styles.btnPrimary} onClick={onNewDocument}>+ New document</button>
        )}
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
