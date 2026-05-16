import { defraFetch } from './client'
import type { DefraConfig } from './client'
import type { PeerInfo } from './types'

// API returns multiaddr strings: "/ip4/127.0.0.1/tcp/9172/p2p/<peerID>"
function parseMultiaddr(addr: string): PeerInfo {
  const id = addr.split('/p2p/')[1] ?? addr
  return { id, addr }
}

export async function fetchPeers(config: DefraConfig): Promise<PeerInfo[]> {
  const result = await defraFetch<string[] | PeerInfo[]>(config, '/p2p/active-peers')
  if (!Array.isArray(result)) return []
  return result.map(item =>
    typeof item === 'string' ? parseMultiaddr(item) : item,
  )
}

export interface NodeInfo {
  peerID: string
  addrs: string[]
}

export async function fetchNodeInfo(config: DefraConfig): Promise<NodeInfo | null> {
  const addrs = await defraFetch<string[]>(config, '/p2p/info')
  if (!Array.isArray(addrs) || addrs.length === 0) return null
  const peerID = addrs[0].split('/p2p/')[1] ?? ''
  return { peerID, addrs }
}

export async function fetchP2PCollections(config: DefraConfig): Promise<string[]> {
  const result = await defraFetch<string[]>(config, '/p2p/collections')
  return Array.isArray(result) ? result : []
}

export async function connectPeer(config: DefraConfig, multiaddr: string): Promise<void> {
  await defraFetch<void>(config, '/p2p/connect', {
    method: 'POST',
    body: JSON.stringify([multiaddr]),
  })
}
