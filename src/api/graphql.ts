import { getIntrospectionQuery } from 'graphql'
import type { DefraConfig } from './client'
import type { GraphQLResponse, IntrospectionResult, IntrospectionTypeRef, CollectionDescription } from './types'
import { defraFetch } from './client'
import { fetchCollections } from './collections'

// ── Schema management ────────────────────────────────────────────────────────

export async function createCollection(config: DefraConfig, sdl: string): Promise<CollectionDescription[]> {
  const raw = await defraFetch<Record<string, unknown>[]>(config, '/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: sdl,
  })
  // POST returns the newly created collections with PascalCase keys — normalize via fetchCollections
  // by re-fetching the names that came back
  const names = new Set((raw ?? []).map(c => String(c.Name ?? c.name ?? '')).filter(Boolean))
  if (names.size === 0) return []
  const all = await fetchCollections(config)
  return all.filter(c => names.has(c.name))
}

// Converts SDL like `type User { newField: String }` into a DefraDB JSON Patch array.
// Each field becomes an "add" op at /<TypeName>/Fields/-.
export function sdlToCollectionPatchOps(sdl: string): object[] {
  const typeMatch = sdl.match(/type\s+(\w+)\s*\{([^}]*)\}/s)
  if (!typeMatch) throw new Error('Could not parse SDL — expected `type TypeName { ... }`')

  const typeName = typeMatch[1]
  const body = typeMatch[2]

  const ops: object[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    const fieldMatch = trimmed.match(/^(\w+)\s*:\s*([\w[\]!]+)(.*)$/)
    if (!fieldMatch) continue
    const [, name, kindRaw, rest] = fieldMatch
    const kind = kindRaw.replace(/[[\]!]/g, '') // strip NonNull/List wrappers

    const value: Record<string, string> = { Name: name, Kind: kind }

    // Parse @crdt(type: <value>)
    const crdtMatch = rest.match(/@crdt\s*\(\s*type\s*:\s*(\w+)/)
    if (crdtMatch) value.Typ = crdtMatch[1]

    ops.push({ op: 'add', path: `/${typeName}/Fields/-`, value })
  }

  if (ops.length === 0) throw new Error('No fields found in SDL')
  return ops
}

export function sdlToCollectionPatch(sdl: string): string {
  return JSON.stringify(sdlToCollectionPatchOps(sdl))
}

export async function addFieldToCollection(
  config: DefraConfig,
  collectionName: string,
  fieldName: string,
  kind: string,
  crdt?: string,
): Promise<CollectionDescription[]> {
  const value: Record<string, string> = { Name: fieldName, Kind: kind }
  if (crdt) value.Typ = crdt
  const patch = JSON.stringify([{ op: 'add', path: `/${collectionName}/Fields/-`, value }])
  await defraFetch<unknown>(config, '/collections', {
    method: 'PATCH',
    body: JSON.stringify({ Patch: patch }),
  })
  const all = await fetchCollections(config)
  return all.filter(c => c.name === collectionName)
}

export async function setCollectionActive(
  config: DefraConfig,
  collectionName: string,
  isActive: boolean,
): Promise<void> {
  const patch = JSON.stringify([{ op: 'replace', path: `/${collectionName}/IsActive`, value: isActive }])
  await defraFetch<unknown>(config, '/collections', {
    method: 'PATCH',
    body: JSON.stringify({ Patch: patch }),
  })
}

export async function deleteCollectionByName(config: DefraConfig, collectionName: string): Promise<void> {
  await defraFetch<unknown>(config, '/collections', {
    method: 'DELETE',
    body: JSON.stringify({ name: collectionName }),
  })
}

export async function patchCollection(config: DefraConfig, sdl: string): Promise<CollectionDescription[]> {
  const patch = sdlToCollectionPatch(sdl)
  const typeMatch = sdl.match(/type\s+(\w+)/)
  const typeName = typeMatch?.[1] ?? ''

  await defraFetch<unknown>(config, '/collections', {
    method: 'PATCH',
    body: JSON.stringify({ Patch: patch }),
  })

  // Return only the patched collection (normalized)
  const all = await fetchCollections(config)
  return typeName ? all.filter(c => c.name === typeName) : []
}

// ── Subscription executor (SSE) ───────────────────────────────────────────────

export async function* subscribeGraphQL(
  config: DefraConfig,
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<GraphQLResponse> {
  const url = `${config.baseUrl}/api/v0/graphql`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  }
  if (config.token) headers['Authorization'] = `Bearer ${config.token}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
    signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new Error(`HTTP ${res.status}: ${body}`)
  }

  if (!res.body) throw new Error('No response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE events are separated by double newlines
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        if (!part.trim()) continue
        let eventType = 'next'
        let data = ''
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim()
          else if (line.startsWith('data: ')) data = line.slice(6).trim()
        }
        if (eventType === 'complete') return
        if (data) {
          try { yield JSON.parse(data) as GraphQLResponse }
          catch { /* skip malformed events */ }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── Core executor ────────────────────────────────────────────────────────────

export async function executeGraphQL<T = Record<string, unknown>>(
  config: DefraConfig,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  const url = `${config.baseUrl}/api/v0/graphql`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.token) headers['Authorization'] = `Bearer ${config.token}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new Error(`HTTP ${res.status}: ${body}`)
  }

  return res.json() as Promise<GraphQLResponse<T>>
}

// ── Introspection ────────────────────────────────────────────────────────────

// Use the standard full introspection query so buildClientSchema works for autocomplete
const INTROSPECTION_QUERY = getIntrospectionQuery()

export async function fetchIntrospection(config: DefraConfig): Promise<IntrospectionResult> {
  const res = await executeGraphQL<IntrospectionResult>(config, INTROSPECTION_QUERY)
  if (res.errors?.length) throw new Error(res.errors[0].message)
  if (!res.data) throw new Error('Empty introspection response')
  return res.data
}

// ── Schema helpers ───────────────────────────────────────────────────────────

export function getBaseKind(type: IntrospectionTypeRef): string {
  return type.kind === 'NON_NULL' || type.kind === 'LIST'
    ? getBaseKind(type.ofType!)
    : type.kind
}

export function isScalarField(type: IntrospectionTypeRef): boolean {
  return getBaseKind(type) === 'SCALAR'
}

/** Build a paginated GraphQL query for a collection */
/** Build a targeted single-field filter arg string. */
export function buildSearchFilter(term: string, field: string, fieldType = 'String', op = '', relationFields?: Set<string>): string {
  if (!term.trim() || !field) return ''
  const t = term.trim()

  // Relation object fields: filter via nested _docID rather than a direct operator
  if (relationFields?.has(field)) {
    return `filter: { ${field}: { _docID: { _eq: ${JSON.stringify(t)} } } }`
  }

  // Default operator by type
  const defaultOp = (fieldType === 'String' && field !== '_docID') ? '_ilike' : '_eq'
  const operator = op || defaultOp

  // Coerce value to correct GraphQL literal
  let value: string
  if (fieldType === 'Boolean') {
    value = t === 'true' ? 'true' : 'false'
  } else if (fieldType === 'Int') {
    const n = parseInt(t, 10)
    if (isNaN(n)) return ''
    value = String(n)
  } else if (fieldType === 'Float') {
    const n = parseFloat(t)
    if (isNaN(n)) return ''
    value = String(n)
  } else if (['_ilike', '_nilike', '_like', '_nlike'].includes(operator)) {
    value = JSON.stringify(t.includes('%') ? t : `%${t}%`)
  } else {
    value = JSON.stringify(t)
  }

  return `filter: { ${field}: { ${operator}: ${value} } }`
}

export function buildDocumentsQuery(typeName: string, fields: string[], limit: number, offset: number, filterArg = '', relationFields?: Set<string>): string {
  const args = [filterArg, `limit: ${limit}`, `offset: ${offset}`].filter(Boolean).join(', ')
  const selection = fields.map(f =>
    relationFields?.has(f) ? `    ${f} { _docID }` : `    ${f}`
  ).join('\n')
  return `{ ${typeName}(${args}) {\n${selection}\n  } }`
}

/** Build a count query using DefraDB's top-level COUNT aggregate */
export function buildCountQuery(typeName: string, filterArg = ''): string {
  return filterArg
    ? `{ COUNT(${typeName}: { ${filterArg} }) }`
    : `{ COUNT(${typeName}: {}) }`
}

/** Build a single aliased query that fetches counts for all collections at once */
export function buildAllCountsQuery(typeNames: string[]): string {
  const lines = typeNames.map(n => `  ${n}: COUNT(${n}: {})`)
  return `{\n${lines.join('\n')}\n}`
}
