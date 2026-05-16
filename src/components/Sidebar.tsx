import { useState } from 'react'
import type { Tab } from '../types'
import { LayoutGrid, Table, Code2, FileText, GitCommit, Network, ChevronsLeft, ChevronsRight, GitBranch } from 'lucide-react'
import { useCollections } from '../hooks/useCollections'
import { useViews } from '../hooks/useViews'
import { usePeers } from '../hooks/usePeers'
import styles from './Sidebar.module.css'

interface Props {
  activeCollection: string | null
  onSelectCollection: (name: string) => void
  activeTab: Tab
  onSelectTab: (tab: Tab) => void
}

export default function Sidebar({ activeCollection, onSelectCollection, activeTab, onSelectTab }: Props) {
  const { data: collections, isLoading, isError } = useCollections()
  const { data: views } = useViews()
  const { data: peers } = usePeers()
  const peerCount = peers?.length ?? 0
  const [collapsed, setCollapsed] = useState(false)

  if (collapsed) {
    return (
      <aside className={`${styles.sidebar} ${styles.sidebarCollapsed}`}>
        <div className={styles.collapseRow}>
          <button className={styles.collapseBtn} onClick={() => setCollapsed(false)} title="Expand sidebar">
            <ChevronsRight size={13} />
          </button>
        </div>
        <div className={styles.collapsedIcons}>
          <IconBtn icon={<LayoutGrid size={15} />} active={activeTab === 'dashboard'} onClick={() => onSelectTab('dashboard')} title="Dashboard" />
          <IconBtn icon={<Table size={15} />}      active={activeTab === 'collections'} onClick={() => onSelectTab('collections')} title="Collections" />
          <IconBtn icon={<Code2 size={15} />}      active={activeTab === 'query'}    onClick={() => onSelectTab('query')} title="Query Runner" />
          <IconBtn icon={<FileText size={15} />}   active={activeTab === 'schema'}   onClick={() => onSelectTab('schema')} title="Schema" />
          <IconBtn icon={<GitCommit size={15} />}  active={activeTab === 'commits'}  onClick={() => onSelectTab('commits')} title="Commits" />
          <IconBtn icon={<Network size={15} />}    active={activeTab === 'peers'}    onClick={() => onSelectTab('peers')} title="Peers" />
        </div>
        <div className={styles.collapsedFooter}>
          <span className={`${styles.peerDotSmall} ${peerCount > 0 ? styles.peerOnline : styles.peerOffline}`} />
        </div>
      </aside>
    )
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.collapseRow}>
        <button className={styles.collapseBtn} onClick={() => setCollapsed(true)} title="Collapse sidebar">
          <ChevronsLeft size={13} />
        </button>
      </div>
      <div className={styles.section}>
        <p className={styles.label}>Overview</p>
        <NavItem icon={<LayoutGrid size={14} />} label="Dashboard"    active={activeTab === 'dashboard'} onClick={() => onSelectTab('dashboard')} />
        <NavItem icon={<Table size={14} />}      label="Collections"  badge={collections ? String(collections.length) : undefined} active={activeTab === 'collections'} onClick={() => onSelectTab('collections')} />
        <NavItem icon={<Code2 size={14} />}      label="Query Runner" active={activeTab === 'query'}    onClick={() => onSelectTab('query')} />
        <NavItem icon={<FileText size={14} />}   label="Schema"       active={activeTab === 'schema'}   onClick={() => onSelectTab('schema')} />
        <NavItem icon={<GitCommit size={14} />}  label="Commits"      active={activeTab === 'commits'}  onClick={() => onSelectTab('commits')} />
      </div>

      <div className={styles.section}>
        <p className={styles.label}>Network</p>
        <NavItem icon={<Network size={14} />} label="Peers" badge={peerCount > 0 ? String(peerCount) : undefined} active={activeTab === 'peers'} onClick={() => onSelectTab('peers')} />
      </div>

      <div className={styles.collectionSection}>
        <p className={styles.label} style={{ padding: '8px 8px 4px' }}>Collections</p>

        {isLoading && (
          <div className={styles.skeletonGroup}>
            {[1, 2, 3, 4].map(i => <div key={i} className={styles.skeleton} style={{ width: `${55 + i * 10}%` }} />)}
          </div>
        )}

        {isError && (
          <p className={styles.errorNote}>Could not load collections.</p>
        )}

        {collections?.map(c => (
          <button
            key={c.name}
            className={`${styles.collectionItem} ${c.name === activeCollection ? styles.collectionActive : ''}`}
            onClick={() => { onSelectCollection(c.name); onSelectTab('collections') }}
          >
            <span className={styles.collectionDot} style={{ opacity: c.name === activeCollection ? 1 : 0.4 }} />
            {c.name}
            {c.is_branchable && (
              <GitBranch size={10} className={styles.branchIcon} aria-label="Branchable" />
            )}
          </button>
        ))}

        {views && views.length > 0 && (
          <>
            <p className={styles.label} style={{ padding: '12px 8px 4px' }}>Views</p>
            {views.map(v => (
              <button
                key={v.name}
                className={`${styles.collectionItem} ${styles.viewItem} ${v.name === activeCollection ? styles.collectionActive : ''}`}
                onClick={() => { onSelectCollection(v.name); onSelectTab('collections') }}
              >
                <span className={styles.collectionDot} style={{ opacity: v.name === activeCollection ? 1 : 0.4, background: 'var(--gray-500)' }} />
                {v.name}
              </button>
            ))}
          </>
        )}
      </div>

      <div className={styles.footer}>
        <div className={styles.peerStatus}>
          <span className={`${styles.peerDot} ${peerCount > 0 ? styles.peerOnline : styles.peerOffline}`} />
          <div className={styles.peerInfo}>
            <span className={styles.peerLabel}>
              {peerCount > 0 ? `${peerCount} peer${peerCount > 1 ? 's' : ''} connected` : 'No peers'}
            </span>
            {peers?.[0]?.id && (
              <span className={styles.peerId}>{peers[0].id.slice(0, 20)}…</span>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

function NavItem({ icon, label, badge, active, onClick }: {
  icon: React.ReactNode; label: string; badge?: string; active: boolean; onClick: () => void
}) {
  return (
    <button className={`${styles.navItem} ${active ? styles.navActive : ''}`} onClick={onClick}>
      <span className={styles.navIcon}>{icon}</span>
      {label}
      {badge && <span className={styles.navBadge}>{badge}</span>}
    </button>
  )
}

function IconBtn({ icon, active, onClick, title }: {
  icon: React.ReactNode; active: boolean; onClick: () => void; title: string
}) {
  return (
    <button
      className={`${styles.iconBtn} ${active ? styles.iconBtnActive : ''}`}
      onClick={onClick}
      title={title}
    >
      {icon}
    </button>
  )
}
