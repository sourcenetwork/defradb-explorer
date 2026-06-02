import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useConfig } from '../context/ConfigContext'
import { useIntrospection } from './useIntrospection'
import { executeGraphQL, buildDocumentsQuery, buildCountQuery, buildAllCountsQuery, buildSearchFilter, isScalarField } from '../api/graphql'
import { queryKeys } from '../lib/queryKeys'

// DefraDB exposes aggregate functions as scalar fields on every collection type.
// They require arguments (e.g. AVG(field: "score")) so they cannot be queried bare.
const AGGREGATE_FIELDS = new Set(['AVG', 'COUNT', 'MAX', 'MIN', 'SUM', 'SIMILARITY'])

export const PAGE_SIZE = 25

export function useDocuments(collectionName: string, page: number, search = '', searchField = '', searchFieldType = 'String', searchOp = '', limit = PAGE_SIZE, fetchFields?: string[], relationFields?: Set<string>) {
  const { config } = useConfig()
  const { data: schema } = useIntrospection()

  const scalarFields = useMemo(() => {
    if (!schema) return null
    const type = schema.__schema.types.find(t => t.name === collectionName)
    if (!type?.fields) return null
    return type.fields
      .filter(f =>
        isScalarField(f.type) &&
        !AGGREGATE_FIELDS.has(f.name) &&
        (f.name === '_docID' || f.name === '_deleted' || !f.name.startsWith('_')),
      )
      .map(f => f.name)
  }, [schema, collectionName])

  // Use caller-supplied field list if provided, else all scalar fields
  const queryFields = fetchFields && fetchFields.length > 0 ? fetchFields : scalarFields

  const offset = (page - 1) * limit
  const filterArg = buildSearchFilter(search, searchField, searchFieldType, searchOp, relationFields)

  const relationKey = relationFields ? [...relationFields].sort().join(',') : ''

  const query = useMemo(
    () => queryFields ? buildDocumentsQuery(collectionName, queryFields, limit, offset, filterArg, relationFields) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collectionName, queryFields, limit, offset, filterArg, relationKey],
  )

  const fieldsKey = fetchFields?.join(',') ?? ''

  // Full field list for the column picker: scalars + relation object fields
  const allFields = useMemo(() => {
    const base = scalarFields ?? []
    const rels = relationFields ? [...relationFields] : []
    return [...new Set([...base, ...rels])]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scalarFields, relationKey])

  return useQuery({
    queryKey: queryKeys.documents(config.baseUrl, collectionName, page, `${searchField}:${searchFieldType}:${searchOp}:${search}:${limit}:${fieldsKey}:${relationKey}`),
    queryFn: async () => {
      const res = await executeGraphQL<Record<string, unknown[]>>(config, query!)
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return {
        rows: res.data?.[collectionName] ?? [],
        fields: allFields,
      }
    },
    enabled: query !== null,
    staleTime: 15_000,
    placeholderData: prev => prev,
  })
}

/** Fetch counts for all given collections in a single aliased request */
export function useAllDocumentCounts(collectionNames: string[]) {
  const { config } = useConfig()

  return useQuery({
    queryKey: queryKeys.allDocumentCounts(config.baseUrl, collectionNames),
    queryFn: async () => {
      const query = buildAllCountsQuery(collectionNames)
      const res = await executeGraphQL<Record<string, number>>(config, query)
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return res.data ?? {}
    },
    enabled: collectionNames.length > 0,
    staleTime: 15_000,
  })
}

export function useDocumentById(collectionName: string, docID: string | null, scalarFields: string[], relationFields?: Set<string>) {
  const { config } = useConfig()
  const allFields = [...scalarFields, ...(relationFields ? [...relationFields] : [])].filter(f => f !== '_deleted')
  const selection = allFields.map(f => relationFields?.has(f) ? `${f} { _docID }` : f).join(' ')
  return useQuery({
    queryKey: ['document-by-id', config.baseUrl, collectionName, docID, ...(relationFields ? [...relationFields].sort() : [])],
    queryFn: async () => {
      const query = `{ ${collectionName}(filter: { _docID: { _eq: ${JSON.stringify(docID)} } }) { ${selection} } }`
      const res = await executeGraphQL<Record<string, unknown[]>>(config, query)
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return (res.data?.[collectionName]?.[0] ?? null) as Record<string, unknown> | null
    },
    enabled: !!docID && allFields.length > 0,
    staleTime: 15_000,
  })
}

export function useDocumentAtVersion(collection: string, cid: string | null, scalarFields: string[]) {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['doc-at-version', config.baseUrl, collection, cid],
    queryFn: async () => {
      const fieldSel = scalarFields.filter(f => f !== '_deleted' && f !== '_docID').join(' ')
      const query = `{ ${collection}(cid: ${JSON.stringify([cid])}) { ${fieldSel} } }`
      const res = await executeGraphQL<Record<string, unknown[]>>(config, query)
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return (res.data?.[collection]?.[0] ?? null) as Record<string, unknown> | null
    },
    enabled: !!cid && scalarFields.filter(f => f !== '_deleted' && f !== '_docID').length > 0,
    staleTime: Infinity,
  })
}

export function useDocumentCount(collectionName: string, search = '', searchField = '', searchFieldType = 'String', searchOp = '', relationFields?: Set<string>) {
  const { config } = useConfig()

  return useQuery({
    queryKey: queryKeys.documentCount(config.baseUrl, collectionName, `${searchField}:${searchFieldType}:${searchOp}:${search}`),
    queryFn: async () => {
      const filterArg = buildSearchFilter(search, searchField, searchFieldType, searchOp, relationFields)
      const countQuery = buildCountQuery(collectionName, filterArg)
      const res = await executeGraphQL<{ COUNT?: number }>(config, countQuery)
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return res.data?.COUNT ?? 0
    },
    enabled: !!collectionName,
    staleTime: 15_000,
  })
}
