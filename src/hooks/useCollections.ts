import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { fetchCollections } from '../api/collections'
import { queryKeys } from '../lib/queryKeys'

export function useCollections() {
  const { config } = useConfig()

  return useQuery({
    queryKey: queryKeys.collections(config.baseUrl),
    queryFn: () => fetchCollections(config),
    staleTime: 30_000,
  })
}
