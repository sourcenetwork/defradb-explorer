import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { fetchNodeInfo } from '../api/peers'
import { queryKeys } from '../lib/queryKeys'

export function useNodeInfo() {
  const { config } = useConfig()
  return useQuery({
    queryKey: queryKeys.nodeInfo(config.baseUrl),
    queryFn: () => fetchNodeInfo(config),
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
}
