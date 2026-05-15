import type { DefraConfig } from './client'

// DefraDB has no dedicated health endpoint — use a minimal GraphQL introspection
// query as a ping. { __typename } is the lightest valid GraphQL request.
export async function checkHealth(config: DefraConfig): Promise<boolean> {
  const url = `${config.baseUrl}/api/v0/graphql`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.token) headers['Authorization'] = `Bearer ${config.token}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: '{ __typename }' }),
    signal: AbortSignal.timeout(4000),
  })
  return res.ok
}
