import { usePeers } from '../hooks/usePeers'
import { useReplicators } from '../hooks/useReplicators'
import { useConfig } from '../context/ConfigContext'
import { useCollections } from '../hooks/useCollections'
import styles from './DashboardView.module.css'

export default function DashboardView() {
  const { config }         = useConfig()
  const { data: collections, isLoading: collLoad } = useCollections()
  const { data: peers }    = usePeers()
  const { data: replicators } = useReplicators()

  const peerCount  = peers?.length ?? 0
  const repCount   = replicators?.length ?? 0
  const collCount  = collections?.length ?? 0

  return (
    <div className={styles.view}>

      {/* ── Summary stats ─────────────────────────────────────────────── */}
      <div className={styles.statsRow}>
        <StatCard label="Collections" value={collLoad ? '…' : String(collCount)} accent="var(--defradb)" />
        <StatCard label="Active Peers"    value={String(peerCount)} accent={peerCount > 0 ? 'var(--green-btn)' : undefined} />
        <StatCard label="Replicators"     value={String(repCount)}  accent={repCount  > 0 ? '#e0a96d' : undefined} />
        <StatCard label="Endpoint"        value={config.baseUrl} mono />
      </div>

      {/* ── Network ───────────────────────────────────────────────────── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Network</h2>
        <div className={styles.networkGrid}>
          <div className={styles.netCard}>
            <p className={styles.netCardLabel}>Connected Peers</p>
            {!peerCount ? (
              <p className={styles.netEmpty}>No active connections</p>
            ) : (
              <div className={styles.peerList}>
                {peers!.map(p => (
                  <div key={p.id} className={styles.peerRow}>
                    <span className={styles.peerDot} />
                    <span className={styles.peerId} title={p.id}>{p.id}</span>
                    <span className={styles.peerAddr}>{p.addr.split('/p2p/')[0]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={styles.netCard}>
            <p className={styles.netCardLabel}>Replicators</p>
            {!repCount ? (
              <p className={styles.netEmpty}>No replicators configured</p>
            ) : (
              <div className={styles.peerList}>
                {replicators!.map(r => (
                  <div key={r.ID} className={styles.peerRow}>
                    <span className={`${styles.peerDot} ${(peers ?? []).some(p => p.id === r.ID) ? styles.peerDotOnline : styles.peerDotOffline}`} />
                    <span className={styles.peerId} title={r.ID}>
                      {r.ID.slice(0, 12)}…{r.ID.slice(-6)}
                    </span>
                    <span className={styles.peerAddr}>{r.CollectionIDs.length} collection{r.CollectionIDs.length !== 1 ? 's' : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

    </div>
  )
}

function StatCard({ label, value, accent, mono }: { label: string; value: string; accent?: string; mono?: boolean }) {
  return (
    <div className={styles.statCard}>
      <p className={styles.statLabel}>{label}</p>
      <p className={`${styles.statValue} ${mono ? styles.statMono : ''}`} style={accent ? { color: accent } : undefined}>
        {value}
      </p>
    </div>
  )
}
