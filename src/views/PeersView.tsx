import { useQueryClient } from '@tanstack/react-query'
import { usePeers } from '../hooks/usePeers'
import { useReplicators } from '../hooks/useReplicators'
import { useCollections } from '../hooks/useCollections'
import { queryKeys } from '../lib/queryKeys'
import { useConfig } from '../context/ConfigContext'
import styles from './PeersView.module.css'

const STATUS_LABEL: Record<number, string> = {
  0: 'active',
  1: 'idle',
  2: 'error',
}

function shortID(id: string) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id
}

export default function PeersView() {
  const { config } = useConfig()
  const queryClient = useQueryClient()
  const { data: peers,       isLoading: peersLoading }       = usePeers()
  const { data: replicators, isLoading: repLoading, refetch } = useReplicators()
  const { data: collections }                                  = useCollections()

  const collectionNameById = Object.fromEntries(
    (collections ?? []).map(c => [c.id, c.name])
  )

  function refresh() {
    queryClient.invalidateQueries({ queryKey: queryKeys.peers(config.baseUrl) })
    refetch()
  }

  const activePeerIDs = new Set((peers ?? []).map(p => p.id))

  return (
    <div className={styles.view}>

      {/* ── Active peers ──────────────────────────────────────────────── */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Active Peers</h2>
          <button className={styles.btnSm} onClick={refresh}>↺ Refresh</button>
        </div>

        {peersLoading ? (
          <div className={styles.empty}>Checking…</div>
        ) : !peers?.length ? (
          <div className={styles.empty}>
            No active peer connections.
            <span className={styles.emptyHint}>
              Run a second node and connect with <code>defradb client p2p connect</code>
            </span>
          </div>
        ) : (
          <div className={styles.cards}>
            {peers.map(p => (
              <div key={p.id} className={styles.peerCard}>
                <div className={styles.peerOnlineDot} />
                <div className={styles.peerBody}>
                  <p className={styles.peerID} title={p.id}>{p.id}</p>
                  <p className={styles.peerAddr}>{p.addr}</p>
                </div>
                <span className={styles.badge} style={{ background: 'rgba(57,226,101,0.12)', color: 'var(--green-btn)' }}>
                  connected
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Replicators ───────────────────────────────────────────────── */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Replicators</h2>
          <span className={styles.sectionHint}>
            Use <code>defradb client p2p replicator add</code> to configure
          </span>
        </div>

        {repLoading ? (
          <div className={styles.empty}>Loading…</div>
        ) : !replicators?.length ? (
          <div className={styles.empty}>
            No replicators configured.
            <span className={styles.emptyHint}>
              Example: <code>defradb client p2p replicator add --collection User &lt;multiaddr&gt;</code>
            </span>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Peer</th>
                <th>Collections</th>
                <th>Status</th>
                <th>Last change</th>
              </tr>
            </thead>
            <tbody>
              {replicators.map(r => {
                const isOnline = activePeerIDs.has(r.ID)
                const statusLabel = STATUS_LABEL[r.Status] ?? 'unknown'
                const collNames = r.CollectionIDs
                  .map(id => collectionNameById[id] ?? shortID(id))
                const changed = new Date(r.LastStatusChange).toLocaleString()
                return (
                  <tr key={r.ID}>
                    <td>
                      <div className={styles.repPeer}>
                        <span className={`${styles.dot} ${isOnline ? styles.dotOnline : styles.dotOffline}`} />
                        <span className={styles.repID} title={r.ID}>{shortID(r.ID)}</span>
                      </div>
                    </td>
                    <td>
                      <div className={styles.collTags}>
                        {collNames.map(n => (
                          <span key={n} className={styles.collTag}>{n}</span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <span className={`${styles.statusBadge} ${styles['status_' + statusLabel]}`}>
                        {statusLabel}
                      </span>
                    </td>
                    <td className={styles.changed}>{changed}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Connect hint ──────────────────────────────────────────────── */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Quick Reference</h2>
        </div>
        <div className={styles.codeBlock}>
          <p className={styles.codeLabel}>Get this node's peer address</p>
          <pre className={styles.code}>curl {config.baseUrl}/api/v0/p2p/info</pre>
        </div>
        <div className={styles.codeBlock}>
          <p className={styles.codeLabel}>Connect to a peer</p>
          <pre className={styles.code}>defradb client p2p connect --url {config.baseUrl.replace(/^https?:\/\//, '')} &lt;multiaddr&gt;</pre>
        </div>
        <div className={styles.codeBlock}>
          <p className={styles.codeLabel}>Add a replicator</p>
          <pre className={styles.code}>defradb client p2p replicator add --url {config.baseUrl.replace(/^https?:\/\//, '')} --collection User &lt;multiaddr&gt;</pre>
        </div>
      </section>

    </div>
  )
}
