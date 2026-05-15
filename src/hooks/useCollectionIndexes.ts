import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { fetchCollectionIndexes } from '../api/collections'

export function useCollectionIndexes(collectionName: string | null) {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['collection-indexes', config.baseUrl, collectionName],
    queryFn: () => fetchCollectionIndexes(config, collectionName!),
    enabled: !!collectionName,
    staleTime: 30_000,
  })
}
