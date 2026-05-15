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
    name:       String(c.Name ?? ''),
    id:         String(c.CollectionID ?? ''),
    version_id: String(c.VersionID ?? ''),
    fields:     rawFields.map(normalizeField),
  }
}

export async function fetchCollections(config: DefraConfig): Promise<CollectionDescription[]> {
  const result = await defraFetch<Record<string, unknown>[] | Record<string, unknown>>(config, '/collections')
  const arr = Array.isArray(result) ? result : [result]
  return arr.map(normalizeCollection)
}

export async function fetchCollectionIndexes(config: DefraConfig, collectionName: string): Promise<CollectionIndex[]> {
  const result = await defraFetch<CollectionIndex[]>(config, `/collections/${encodeURIComponent(collectionName)}/indexes`)
  return Array.isArray(result) ? result : []
}
