import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { fetchPeers } from '../api/peers'
import { queryKeys } from '../lib/queryKeys'

export function usePeers() {
  const { config } = useConfig()

  return useQuery({
    queryKey: queryKeys.peers(config.baseUrl),
    queryFn: () => fetchPeers(config),
    refetchInterval: 15_000,
    staleTime: 10_000,
  })
}
