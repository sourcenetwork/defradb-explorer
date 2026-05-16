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
  collectionVersionId: string | null
  links: CommitLink[]
  signature?: { identity: string | null } | null
}

const COMMIT_FIELDS = `cid docID height fieldName delta collectionVersionId links { cid fieldName height } signature { identity }`
const COMPOSITE_FIELDS = `cid docID height fieldName collectionVersionId links { cid fieldName height } signature { identity }`

// Raw commits fetched per page. Composite commits (~1 per version) are roughly
// 1-in-N of all commits depending on fields per type. 200 raw gives a generous
// window; client filters to composites and signals hasMore from the raw count.
export const RAW_PAGE_SIZE = 200

export function useRecentCommitsPage(rawOffset: number) {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['commits', 'recent-page', config.baseUrl, rawOffset],
    queryFn: async () => {
      const res = await executeGraphQL<{ _commits: Commit[] }>(
        config,
        `{ _commits(limit: ${RAW_PAGE_SIZE}, offset: ${rawOffset}, order: [{ height: DESC }]) { ${COMPOSITE_FIELDS} } }`,
      )
      if (res.errors?.length) throw new Error(res.errors[0].message)
      const all = res.data?._commits ?? []
      const composites = all.filter(c => c.fieldName === '_C' || c.fieldName === null)
      return { composites, hasMore: all.length === RAW_PAGE_SIZE }
    },
    staleTime: 15_000,
    refetchInterval: rawOffset === 0 ? 30_000 : false,
  })
}

const DOC_PAGE_SIZE = 500

export function useDocumentCommits(docID: string | null) {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['commits', 'doc', config.baseUrl, docID],
    queryFn: async () => {
      const all: Commit[] = []
      let offset = 0
      while (true) {
        const res = await executeGraphQL<{ _commits: Commit[] }>(
          config,
          `{ _commits(docID: ${JSON.stringify(docID)}, limit: ${DOC_PAGE_SIZE}, offset: ${offset}, order: [{ height: DESC }]) { ${COMMIT_FIELDS} } }`,
        )
        if (res.errors?.length) throw new Error(res.errors[0].message)
        const page = res.data?._commits ?? []
        all.push(...page)
        if (page.length < DOC_PAGE_SIZE) break
        offset += DOC_PAGE_SIZE
      }
      return all
    },
    enabled: !!docID,
    staleTime: 15_000,
  })
}

export function useCommitByCID(cid: string | null) {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['commits', 'by-cid', config.baseUrl, cid],
    queryFn: async () => {
      const res = await executeGraphQL<{ _commits: Commit[] }>(
        config,
        `{ _commits(cid: ${JSON.stringify(cid)}, limit: 1) { ${COMMIT_FIELDS} } }`,
      )
      if (res.errors?.length) throw new Error(res.errors[0].message)
      return res.data?._commits?.[0] ?? null
    },
    enabled: !!cid,
    staleTime: Infinity,
  })
}

export function useNodeIdentity() {
  const { config } = useConfig()
  return useQuery({
    queryKey: ['node', 'identity', config.baseUrl],
    queryFn: async () => {
      const res = await fetch(`${config.baseUrl}/api/v0/node/identity`)
      if (!res.ok) return null
      const data = await res.json() as { PublicKey?: string }
      return data.PublicKey ?? null
    },
    staleTime: Infinity,
  })
}
