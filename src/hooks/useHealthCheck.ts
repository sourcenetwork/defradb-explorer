import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { checkHealth } from '../api/health'
import { queryKeys } from '../lib/queryKeys'

export function useHealthCheck() {
  const { config } = useConfig()

  return useQuery({
    queryKey: queryKeys.health(config.baseUrl),
    queryFn: () => checkHealth(config),
    refetchInterval: 10_000,
    retry: false,
  })
}
