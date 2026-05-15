import { useMemo } from 'react'
import { buildClientSchema } from 'graphql'
import type { IntrospectionQuery } from 'graphql'
import { useIntrospection } from './useIntrospection'

export function useGraphQLSchema() {
  const { data } = useIntrospection()

  return useMemo(() => {
    if (!data) return null
    try {
      return buildClientSchema(data as unknown as IntrospectionQuery)
    } catch {
      return null
    }
  }, [data])
}
