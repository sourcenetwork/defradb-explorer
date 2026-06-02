import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { fetchCollectionsAndViewNames } from '../api/collections'
import { queryKeys } from '../lib/queryKeys'

// Both hooks share the same query key → one HTTP request, one cache entry.

export function useCollections() {
  const { config } = useConfig()
  return useQuery({
    queryKey: queryKeys.collections(config.baseUrl),
    queryFn:  () => fetchCollectionsAndViewNames(config),
    staleTime: 30_000,
    select: d => d.collections,
  })
}

export function useCollectionViewNames() {
  const { config } = useConfig()
  return useQuery({
    queryKey: queryKeys.collections(config.baseUrl),
    queryFn:  () => fetchCollectionsAndViewNames(config),
    staleTime: 30_000,
    select: d => new Set(d.viewNames),
  })
}
