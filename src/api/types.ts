// ── REST response types ─────────────────────────────────────────────────────

export interface CollectionField {
  name: string
  id: string
  kind: string
  is_primary: boolean
  relation_name?: string
}

export interface CollectionDescription {
  name: string
  id: string
  version_id: string
  fields: CollectionField[]
  is_branchable: boolean
  encrypted_indexes: EncryptedIndex[]
}

export interface IndexField {
  Name: string
  Descending: boolean
}

export interface CollectionIndex {
  Name: string
  ID: number
  Fields?: IndexField[]
  Unique: boolean
}

export interface EncryptedIndex {
  field_name: string
  type: string
}

export interface PeerInfo {
  id: string
  addr: string
}

export interface ViewDescription {
  name: string
  query: string
  sdl?: string
  is_materialized?: boolean
}

// ── GraphQL types ────────────────────────────────────────────────────────────

export interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T
  errors?: GraphQLError[]
}

export interface GraphQLError {
  message: string
  extensions?: Record<string, unknown>
  locations?: { line: number; column: number }[]
  path?: string[]
}

// ── Introspection types ──────────────────────────────────────────────────────

export interface IntrospectionTypeRef {
  kind: 'SCALAR' | 'OBJECT' | 'NON_NULL' | 'LIST' | 'ENUM' | 'INPUT_OBJECT' | 'INTERFACE' | 'UNION'
  name?: string | null
  ofType?: IntrospectionTypeRef | null
}

export interface IntrospectionField {
  name: string
  description?: string | null
  type: IntrospectionTypeRef
}

export interface IntrospectionType {
  name: string
  kind: string
  description?: string | null
  fields?: IntrospectionField[] | null
  enumValues?: { name: string; description?: string | null }[] | null
  inputFields?: IntrospectionField[] | null
  interfaces?: IntrospectionTypeRef[] | null
  possibleTypes?: IntrospectionTypeRef[] | null
}

export interface IntrospectionSchema {
  queryType: { name: string } | null
  mutationType?: { name: string } | null
  subscriptionType?: { name: string } | null
  types: IntrospectionType[]
  directives?: unknown[]
}

// IntrospectionResult is intentionally loose so we can pass it to buildClientSchema via cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IntrospectionResult {
  __schema: IntrospectionSchema
}
