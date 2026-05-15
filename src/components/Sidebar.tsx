import type { Tab } from '../types'
import { useCollections } from '../hooks/useCollections'
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
  const { data: peers } = usePeers()
  const peerCount = peers?.length ?? 0

  return (
    <aside className={styles.sidebar}>
      <div className={styles.section}>
        <p className={styles.label}>Overview</p>
        <NavItem icon={<GridIcon />} label="Dashboard" active={activeTab === 'dashboard'} onClick={() => onSelectTab('dashboard')} />
        <NavItem icon={<RowsIcon />} label="Collections"  badge={collections ? String(collections.length) : undefined} active={activeTab === 'collections'} onClick={() => onSelectTab('collections')} />
        <NavItem icon={<CodeIcon />} label="Query Runner" active={activeTab === 'query'}       onClick={() => onSelectTab('query')} />
        <NavItem icon={<DocIcon />}    label="Schema"   active={activeTab === 'schema'}  onClick={() => onSelectTab('schema')} />
        <NavItem icon={<CommitsIcon />} label="Commits" active={activeTab === 'commits'} onClick={() => onSelectTab('commits')} />
      </div>

      <div className={styles.section}>
        <p className={styles.label}>Network</p>
        <NavItem icon={<PeersIcon />} label="Peers" badge={peerCount > 0 ? String(peerCount) : undefined} active={activeTab === 'peers'} onClick={() => onSelectTab('peers')} />
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
            onClick={() => onSelectCollection(c.name)}
          >
            <span className={styles.collectionDot} style={{ opacity: c.name === activeCollection ? 1 : 0.4 }} />
            {c.name}
          </button>
        ))}
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

function GridIcon()  { return <svg width={14} height={14} viewBox="0 0 16 16" fill="none"><rect x={1} y={1} width={6} height={6} rx={1.5} stroke="currentColor" strokeWidth={1.3}/><rect x={9} y={1} width={6} height={6} rx={1.5} stroke="currentColor" strokeWidth={1.3}/><rect x={1} y={9} width={6} height={6} rx={1.5} stroke="currentColor" strokeWidth={1.3}/><rect x={9} y={9} width={6} height={6} rx={1.5} stroke="currentColor" strokeWidth={1.3}/></svg> }
function RowsIcon()  { return <svg width={14} height={14} viewBox="0 0 16 16" fill="none"><rect x={1} y={3} width={14} height={2.5} rx={1} stroke="currentColor" strokeWidth={1.2}/><rect x={1} y={7} width={14} height={2.5} rx={1} stroke="currentColor" strokeWidth={1.2}/><rect x={1} y={11} width={14} height={2.5} rx={1} stroke="currentColor" strokeWidth={1.2}/></svg> }
function CodeIcon()  { return <svg width={14} height={14} viewBox="0 0 16 16" fill="none"><polyline points="3,5 1,8 3,11" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round"/><polyline points="13,5 15,8 13,11" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round"/><line x1={9} y1={2} x2={7} y2={14} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round"/></svg> }
function DocIcon()   { return <svg width={14} height={14} viewBox="0 0 16 16" fill="none"><rect x={1} y={1} width={14} height={14} rx={2} stroke="currentColor" strokeWidth={1.3}/><line x1={5} y1={5} x2={11} y2={5} stroke="currentColor" strokeWidth={1.2} strokeLinecap="round"/><line x1={5} y1={8} x2={9} y2={8} stroke="currentColor" strokeWidth={1.2} strokeLinecap="round"/><line x1={5} y1={11} x2={10} y2={11} stroke="currentColor" strokeWidth={1.2} strokeLinecap="round"/></svg> }
function PeersIcon() { return <svg width={14} height={14} viewBox="0 0 16 16" fill="none"><circle cx={8} cy={8} r={2} stroke="currentColor" strokeWidth={1.3}/><circle cx={2.5} cy={4} r={1.5} stroke="currentColor" strokeWidth={1.2}/><circle cx={13.5} cy={4} r={1.5} stroke="currentColor" strokeWidth={1.2}/><circle cx={2.5} cy={12} r={1.5} stroke="currentColor" strokeWidth={1.2}/><circle cx={13.5} cy={12} r={1.5} stroke="currentColor" strokeWidth={1.2}/><line x1={3.5} y1={5} x2={6.5} y2={7} stroke="currentColor" strokeWidth={1.1}/><line x1={12.5} y1={5} x2={9.5} y2={7} stroke="currentColor" strokeWidth={1.1}/><line x1={3.5} y1={11} x2={6.5} y2={9} stroke="currentColor" strokeWidth={1.1}/><line x1={12.5} y1={11} x2={9.5} y2={9} stroke="currentColor" strokeWidth={1.1}/></svg> }
function CommitsIcon() { return <svg width={14} height={14} viewBox="0 0 16 16" fill="none"><circle cx={8} cy={8} r={2.2} stroke="currentColor" strokeWidth={1.3}/><line x1={8} y1={1} x2={8} y2={5.5} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round"/><line x1={8} y1={10.5} x2={8} y2={15} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round"/></svg> }
