import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { executeGraphQL } from '../api/graphql'

export interface Commit {
  cid: string
  docID: string
  height: number
  fieldName?: string | null
  links: { cid: string }[]
}

export function useDocumentHistory(docID: string | null) {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['history', config.baseUrl, docID],
    queryFn: async () => {
      const res = await executeGraphQL<{ _commits: Commit[] }>(
        config,
        `{ _commits(docID: ${JSON.stringify(docID)}) { cid docID height fieldName links { cid } } }`,
      )
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return res.data?._commits ?? []
    },
    enabled: !!docID,
    staleTime: 10_000,
  })
}
