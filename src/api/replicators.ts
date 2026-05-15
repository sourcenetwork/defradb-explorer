import { defraFetch } from './client'
import type { DefraConfig } from './client'

export interface ReplicatorInfo {
  ID: string
  Addresses: string[]
  CollectionIDs: string[]
  Status: number
  LastStatusChange: string
}

export async function fetchReplicators(config: DefraConfig): Promise<ReplicatorInfo[]> {
  const result = await defraFetch<ReplicatorInfo[]>(config, '/p2p/replicators')
  return Array.isArray(result) ? result : []
}
