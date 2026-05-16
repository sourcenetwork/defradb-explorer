import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { fetchViews, createView, deleteView } from '../api/views'

export function useViews() {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['views', config.baseUrl],
    queryFn:  () => fetchViews(config),
    staleTime: 30_000,
  })
}

export function useCreateView() {
  const { config } = useConfig()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ query, sdl }: { query: string; sdl: string }) =>
      createView(config, query, sdl),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['views', config.baseUrl] }),
  })
}

export function useDeleteView() {
  const { config } = useConfig()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => deleteView(config, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['views', config.baseUrl] }),
  })
}
