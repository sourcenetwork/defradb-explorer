import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { fetchReplicators } from '../api/replicators'

export function useReplicators() {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['replicators', config.baseUrl],
    queryFn: () => fetchReplicators(config),
    refetchInterval: 15_000,
    staleTime: 10_000,
  })
}
