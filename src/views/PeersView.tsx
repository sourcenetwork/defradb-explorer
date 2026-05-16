import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { usePeers } from '../hooks/usePeers'
import { useReplicators } from '../hooks/useReplicators'
import { useCollections } from '../hooks/useCollections'
import { useNodeInfo } from '../hooks/useNodeInfo'
import { useP2PCollections } from '../hooks/useP2PCollections'
import { connectPeer } from '../api/peers'
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ''}`} onClick={copy}>
      {copied ? 'copied' : 'copy'}
    </button>
  )
}

export default function PeersView() {
  const { config } = useConfig()
  const queryClient = useQueryClient()
  const { data: nodeInfo }                                      = useNodeInfo()
  const { data: peers,        isLoading: peersLoading, isError: peersError } = usePeers()
  const { data: replicators,  isLoading: repLoading, refetch } = useReplicators()
  const { data: collections }                                   = useCollections()
  const { data: p2pCollections, refetch: refetchP2P }          = useP2PCollections()

  const [connectAddr, setConnectAddr]   = useState('')
  const [connecting, setConnecting]     = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connectOk, setConnectOk]       = useState(false)

  const collectionNameById = Object.fromEntries(
    (collections ?? []).map(c => [c.id, c.name])
  )

  function refresh() {
    queryClient.invalidateQueries({ queryKey: queryKeys.peers(config.baseUrl) })
    queryClient.invalidateQueries({ queryKey: queryKeys.nodeInfo(config.baseUrl) })
    queryClient.invalidateQueries({ queryKey: queryKeys.p2pCollections(config.baseUrl) })
    refetch()
    refetchP2P()
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault()
    const addr = connectAddr.trim()
    if (!addr) return
    setConnecting(true)
    setConnectError(null)
    setConnectOk(false)
    try {
      await connectPeer(config, addr)
      setConnectOk(true)
      setConnectAddr('')
      queryClient.invalidateQueries({ queryKey: queryKeys.peers(config.baseUrl) })
      setTimeout(() => setConnectOk(false), 3000)
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }

  const activePeerIDs = new Set((peers ?? []).map(p => p.id))

  return (
    <div className={styles.view}>

      {/* ── This node ─────────────────────────────────────────────────── */}
      {nodeInfo && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>This Node</h2>
          </div>
          <div className={styles.nodeCard}>
            <div className={styles.nodeRow}>
              <span className={styles.nodeLabel}>Peer ID</span>
              <span className={styles.nodeValue}>{nodeInfo.peerID}</span>
              <CopyButton text={nodeInfo.peerID} />
            </div>
            {nodeInfo.addrs.map(addr => (
              <div key={addr} className={styles.nodeRow}>
                <span className={styles.nodeLabel}>Address</span>
                <span className={styles.nodeValue}>{addr}</span>
                <CopyButton text={addr} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Connect ───────────────────────────────────────────────────── */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Connect to Peer</h2>
        </div>
        <form className={styles.connectForm} onSubmit={handleConnect}>
          <input
            className={styles.connectInput}
            type="text"
            placeholder="/ip4/127.0.0.1/tcp/9172/p2p/12D3KooW…"
            value={connectAddr}
            onChange={e => setConnectAddr(e.target.value)}
            disabled={connecting}
          />
          <button
            className={`${styles.btnConnect} ${connectOk ? styles.btnConnectOk : ''}`}
            type="submit"
            disabled={connecting || !connectAddr.trim()}
          >
            {connecting ? 'Connecting…' : connectOk ? 'Connected!' : 'Connect'}
          </button>
        </form>
        {connectError && <p className={styles.connectError}>{connectError}</p>}
      </section>

      {/* ── Active peers ──────────────────────────────────────────────── */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Active Peers</h2>
          <button className={styles.btnSm} onClick={refresh}>↺ Refresh</button>
        </div>

        {peersLoading ? (
          <div className={styles.empty}>Checking…</div>
        ) : peersError ? (
          <div className={styles.empty}>
            <span className={styles.emptyError}>Unable to reach node</span>
            <span className={styles.emptyHint}>Peer data unavailable — check the node is running.</span>
          </div>
        ) : !peers?.length ? (
          <div className={styles.empty}>
            No active peer connections.
            <span className={styles.emptyHint}>
              Paste a peer's multiaddr into the Connect form above, or run{' '}
              <code>defradb client p2p connect</code>
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
          <div className={styles.tableWrap}><table className={styles.table}>
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
          </table></div>
        )}
      </section>

      {/* ── P2P Collections ───────────────────────────────────────────── */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>P2P Collections</h2>
          <span className={styles.sectionHint}>
            Collections subscribed to receive changes from the network
          </span>
        </div>

        {!p2pCollections?.length ? (
          <div className={styles.empty}>
            No P2P collection subscriptions.
            <span className={styles.emptyHint}>
              Example: <code>defradb client p2p collection add --collection User</code>
            </span>
          </div>
        ) : (
          <div className={styles.collTagsRow}>
            {p2pCollections.map(id => {
              const name = collectionNameById[id]
              return (
                <span key={id} className={styles.collTag} title={id}>
                  {name ?? shortID(id)}
                </span>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Quick reference ───────────────────────────────────────────── */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Quick Reference</h2>
        </div>
        <div className={styles.codeBlock}>
          <p className={styles.codeLabel}>Add a replicator</p>
          <pre className={styles.code}>defradb client p2p replicator add --url {config.baseUrl.replace(/^https?:\/\//, '')} --collection User &lt;multiaddr&gt;</pre>
        </div>
        <div className={styles.codeBlock}>
          <p className={styles.codeLabel}>Subscribe a collection to P2P</p>
          <pre className={styles.code}>defradb client p2p collection add --url {config.baseUrl.replace(/^https?:\/\//, '')} --collection User</pre>
        </div>
      </section>

    </div>
  )
}
