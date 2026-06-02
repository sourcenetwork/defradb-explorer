import { defraFetch } from './client'
import type { DefraConfig } from './client'
import type { CollectionDescription, CollectionField, CollectionIndex } from './types'

// DefraDB returns PascalCase keys — normalize to our camelCase interface shape
function normalizeField(f: Record<string, unknown>): CollectionField {
  return {
    name:          String(f.Name ?? ''),
    id:            String(f.FieldID ?? ''),
    kind:          String(f.Kind ?? ''),
    is_primary:    Boolean(f.IsPrimary ?? false),
    relation_name: f.RelationName as string | undefined,
  }
}

function normalizeCollection(c: Record<string, unknown>): CollectionDescription {
  const rawFields = Array.isArray(c.Fields) ? c.Fields as Record<string, unknown>[] : []
  return {
    name:          String(c.Name ?? ''),
    id:            String(c.CollectionID ?? ''),
    version_id:    String(c.VersionID ?? ''),
    fields:        rawFields.map(normalizeField),
    is_branchable: Boolean(c.IsBranchable ?? false),
  }
}

// Single fetch that splits collections and view names in one pass.
export async function fetchCollectionsAndViewNames(
  config: DefraConfig,
): Promise<{ collections: CollectionDescription[]; viewNames: string[] }> {
  const result = await defraFetch<Record<string, unknown>[] | Record<string, unknown>>(config, '/collections')
  const arr = Array.isArray(result) ? result : [result]
  const collections: CollectionDescription[] = []
  const viewNames: string[] = []
  for (const c of arr) {
    if (c.Query === null || c.Query === undefined) {
      collections.push(normalizeCollection(c))
    } else {
      viewNames.push(String(c.Name ?? ''))
    }
  }
  return { collections, viewNames }
}

export async function fetchCollections(config: DefraConfig): Promise<CollectionDescription[]> {
  return (await fetchCollectionsAndViewNames(config)).collections
}

export async function fetchCollectionIndexes(config: DefraConfig, collectionName: string): Promise<CollectionIndex[]> {
  const result = await defraFetch<CollectionIndex[]>(config, `/collections/${encodeURIComponent(collectionName)}/indexes`)
  return Array.isArray(result) ? result : []
}
