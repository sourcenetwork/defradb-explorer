import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { executeGraphQL } from '../api/graphql'

export interface CommitLink {
  cid: string
  fieldName: string | null
  height: number
}

export interface Commit {
  cid: string
  docID: string
  height: number
  fieldName: string | null
  delta: string | null
  links: CommitLink[]
}

const COMMIT_FIELDS = `cid docID height fieldName delta links { cid fieldName height }`

export function useRecentCommits(limit = 50) {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['commits', 'recent', config.baseUrl, limit],
    queryFn: async () => {
      const res = await executeGraphQL<{ _commits: Commit[] }>(
        config,
        `{ _commits(limit: ${limit}, order: [{ height: DESC }]) { ${COMMIT_FIELDS} } }`,
      )
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return res.data?._commits ?? []
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  })
}

export function useDocumentCommits(docID: string | null, limit = 100) {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['commits', 'doc', config.baseUrl, docID, limit],
    queryFn: async () => {
      const res = await executeGraphQL<{ _commits: Commit[] }>(
        config,
        `{ _commits(docID: ${JSON.stringify(docID)}, limit: ${limit}, order: [{ height: DESC }]) { ${COMMIT_FIELDS} } }`,
      )
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return res.data?._commits ?? []
    },
    enabled: !!docID,
    staleTime: 15_000,
  })
}
