import type { Document, Collection, SchemaField } from '../types'

export const collections: Collection[] = [
  { name: 'User',       docCount: 1284,  schemaVersion: 'v3' },
  { name: 'Post',       docCount: 18402, schemaVersion: 'v2' },
  { name: 'Comment',    docCount: 24091, schemaVersion: 'v1' },
  { name: 'Tag',        docCount: 312,   schemaVersion: 'v1' },
  { name: 'Attachment', docCount: 4114,  schemaVersion: 'v1' },
  { name: 'AuditLog',   docCount: 48203, schemaVersion: 'v1' },
]

export const documents: Document[] = [
  { docID: 'bae-c3d9a1f2', name: 'Alice Chen',    email: 'alice@example.com',   role: 'admin',  createdAt: '2026-05-12', status: 'active'   },
  { docID: 'bae-f80b2dc4', name: 'Marcus Webb',   email: 'm.webb@example.com',  role: 'editor', createdAt: '2026-05-11', status: 'active'   },
  { docID: 'bae-7e14cc9b', name: 'Priya Nair',    email: 'priya@example.com',   role: 'viewer', createdAt: '2026-05-10', status: 'inactive' },
  { docID: 'bae-2a9f0e38', name: 'Jordan Kim',    email: 'jordan@example.com',  role: 'editor', createdAt: '2026-05-09', status: 'active'   },
  { docID: 'bae-b312f7a1', name: 'Sam Okafor',    email: 'sam@example.com',     role: 'viewer', createdAt: '2026-05-08', status: 'pending'  },
  { docID: 'bae-e541d290', name: 'Lena Fischer',  email: 'lena@example.com',    role: 'admin',  createdAt: '2026-05-07', status: 'active'   },
  { docID: 'bae-d09ca3be', name: 'Tariq Hassan',  email: 'tariq@example.com',   role: 'editor', createdAt: '2026-05-06', status: 'active'   },
  { docID: 'bae-1c47e82d', name: 'Nina Torres',   email: 'nina@example.com',    role: 'viewer', createdAt: '2026-05-05', status: 'inactive' },
]

export const userSchemaFields: SchemaField[] = [
  { name: '_docID',    type: 'ID',       required: true,  description: 'Auto-generated document identifier' },
  { name: 'name',      type: 'String',   required: true,  description: 'Display name of the user' },
  { name: 'email',     type: 'String',   required: true,  description: 'Unique email address' },
  { name: 'role',      type: 'UserRole', required: false, description: 'Permission role — admin · editor · viewer' },
  { name: 'status',    type: 'Status',   required: false, description: 'active · inactive · pending' },
  { name: 'createdAt', type: 'DateTime', required: true,  description: 'ISO-8601 creation timestamp' },
  { name: 'posts',     type: '[Post]',   required: false, description: 'Relation — authored posts' },
]
