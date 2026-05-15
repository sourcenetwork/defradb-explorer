import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { executeGraphQL } from '../api/graphql'
import { queryKeys } from '../lib/queryKeys'

export type FormValues = Record<string, string>
export type TypeMap   = Record<string, string>

function serializeVal(value: string, typeName: string): string {
  if (value === '' || value === undefined) return 'null'
  switch (typeName) {
    case 'Boolean': return value === 'true' ? 'true' : 'false'
    case 'Int':     return String(parseInt(value, 10))
    case 'Float':   return String(parseFloat(value))
    default:        return JSON.stringify(value)
  }
}

function buildObjectLiteral(values: FormValues, typeMap: TypeMap): string {
  const parts = Object.entries(values)
    .filter(([, v]) => v !== '' && v !== undefined)
    .map(([k, v]) => `${k}: ${serializeVal(v, typeMap[k] ?? 'String')}`)
  return parts.length ? '{ ' + parts.join(', ') + ' }' : '{}'
}

export function useCreateDocument(collectionName: string) {
  const { config } = useConfig()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ values, typeMap }: { values: FormValues; typeMap: TypeMap }) => {
      const literal = buildObjectLiteral(values, typeMap)
      const res = await executeGraphQL(config, `mutation { add_${collectionName}(input: [${literal}]) { _docID } }`)
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return res.data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.documentsBase(config.baseUrl, collectionName) }),
  })
}

export function useUpdateDocument(collectionName: string) {
  const { config } = useConfig()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ docID, values, typeMap, original }: { docID: string; values: FormValues; typeMap: TypeMap; original?: FormValues }) => {
      const changed = original
        ? Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== (original[k] ?? '')))
        : values
      const literal = buildObjectLiteral(changed, typeMap)
      const res = await executeGraphQL(
        config,
        `mutation { update_${collectionName}(filter: { _docID: { _eq: ${JSON.stringify(docID)} } }, input: ${literal}) { _docID } }`,
      )
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return res.data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.documentsBase(config.baseUrl, collectionName) }),
  })
}

export function useDeleteDocument(collectionName: string) {
  const { config } = useConfig()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (docID: string) => {
      const res = await executeGraphQL(
        config,
        `mutation { delete_${collectionName}(filter: { _docID: { _eq: ${JSON.stringify(docID)} } }) { _docID } }`,
      )
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return res.data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.documentsBase(config.baseUrl, collectionName) }),
  })
}
