export type Tab = 'dashboard' | 'collections' | 'query' | 'schema' | 'peers' | 'commits'

export type DocStatus = 'active' | 'inactive' | 'pending'

export interface Document {
  docID: string
  name: string
  email: string
  role: string
  createdAt: string
  status: DocStatus
}

export interface Collection {
  name: string
  docCount: number
  schemaVersion: string
}

export interface SchemaField {
  name: string
  type: string
  required: boolean
  description: string
}
