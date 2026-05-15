import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { fetchIntrospection } from '../api/graphql'
import { queryKeys } from '../lib/queryKeys'

export function useIntrospection() {
  const { config } = useConfig()

  return useQuery({
    queryKey: queryKeys.introspection(config.baseUrl),
    queryFn: () => fetchIntrospection(config),
    staleTime: 60_000,
  })
}
