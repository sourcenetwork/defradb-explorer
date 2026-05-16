import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { fetchP2PCollections } from '../api/peers'
import { queryKeys } from '../lib/queryKeys'

export function useP2PCollections() {
  const { config } = useConfig()
  return useQuery({
    queryKey: queryKeys.p2pCollections(config.baseUrl),
    queryFn: () => fetchP2PCollections(config),
    refetchInterval: 15_000,
    staleTime: 10_000,
  })
}
