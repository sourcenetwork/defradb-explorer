import { defraFetch } from './client'
import type { DefraConfig } from './client'
import type { ViewDescription } from './types'

// Reconstruct a rough GraphQL query string from DefraDB's parsed query object
function reconstructQuery(raw: unknown): string {
  try {
    const top = (raw as Record<string, unknown>).Query as Record<string, unknown>
    if (!top) return JSON.stringify(raw, null, 2)
    const name   = String(top.Name ?? '')
    const fields = Array.isArray(top.Fields) ? (top.Fields as Record<string, unknown>[]) : []
    const parts  = fields.map(f => {
      const alias = f.Alias ? `${f.Alias}: ` : ''
      return `    ${alias}${f.Name}`
    })
    return `{\n  ${name} {\n${parts.join('\n')}\n  }\n}`
  } catch {
    return String(raw)
  }
}

function normalizeViewFromCollection(c: Record<string, unknown>): ViewDescription {
  const rawFields = Array.isArray(c.Fields) ? (c.Fields as Record<string, unknown>[]) : []
  const userFields = rawFields.filter(f => {
    const name = String(f.Name ?? '')
    return !name.startsWith('_')
  })
  const sdl = userFields.length
    ? `type ${c.Name} {\n${userFields.map(f => `  ${f.Name}: String`).join('\n')}\n}`
    : undefined
  return {
    name:           String(c.Name ?? ''),
    query:          reconstructQuery(c.Query),
    sdl,
    is_materialized: Boolean(c.IsMaterialized),
  }
}

export async function fetchViews(config: DefraConfig): Promise<ViewDescription[]> {
  const result = await defraFetch<Record<string, unknown>[] | null>(config, '/collections')
  if (!result) return []
  const arr = Array.isArray(result) ? result : [result]
  // Views have a non-null Query field; regular collections have Query: null
  return arr.filter(c => c?.Name && c.Query !== null && c.Query !== undefined).map(normalizeViewFromCollection)
}

export async function createView(
  config: DefraConfig,
  query: string,
  sdl: string,
): Promise<ViewDescription[]> {
  const result = await defraFetch<Record<string, unknown>[] | Record<string, unknown>>(config, '/view', {
    method: 'POST',
    body: JSON.stringify({ Query: query, SDL: sdl }),
  })
  const arr = Array.isArray(result) ? result : result ? [result] : []
  return arr.map(normalizeViewFromCollection)
}

export async function deleteView(config: DefraConfig, name: string): Promise<void> {
  await defraFetch<unknown>(config, '/view', {
    method: 'DELETE',
    body: JSON.stringify({ name }),
  })
}

export async function refreshView(config: DefraConfig, name: string): Promise<void> {
  await defraFetch<unknown>(config, `/view/refresh?name=${encodeURIComponent(name)}`, {
    method: 'POST',
  })
}
