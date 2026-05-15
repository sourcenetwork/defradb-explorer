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
