import { describe, it, expect } from 'vitest'
import {
  buildSearchFilter,
  buildDocumentsQuery,
  buildCountQuery,
  buildAllCountsQuery,
  getBaseKind,
  isScalarField,
  sdlToCollectionPatch,
} from './graphql'
import type { IntrospectionTypeRef } from './types'

// ── buildSearchFilter ─────────────────────────────────────────────────────────

describe('buildSearchFilter', () => {
  it('returns empty string for empty term', () => {
    expect(buildSearchFilter('', 'title')).toBe('')
  })

  it('returns empty string for whitespace-only term', () => {
    expect(buildSearchFilter('   ', 'title')).toBe('')
  })

  it('defaults to _ilike with % wrapping for String fields', () => {
    expect(buildSearchFilter('alice', 'name', 'String'))
      .toBe('filter: { name: { _ilike: "%alice%" } }')
  })

  it('uses _eq for _docID regardless of type', () => {
    expect(buildSearchFilter('abc123', '_docID', 'String'))
      .toBe('filter: { _docID: { _eq: "abc123" } }')
  })

  it('wraps value with % for _like operator', () => {
    expect(buildSearchFilter('foo', 'name', 'String', '_like'))
      .toBe('filter: { name: { _like: "%foo%" } }')
  })

  it('wraps value with % for _nilike operator', () => {
    expect(buildSearchFilter('bar', 'name', 'String', '_nilike'))
      .toBe('filter: { name: { _nilike: "%bar%" } }')
  })

  it('wraps value with % for _nlike operator', () => {
    expect(buildSearchFilter('baz', 'name', 'String', '_nlike'))
      .toBe('filter: { name: { _nlike: "%baz%" } }')
  })

  it('does not wrap value with % for _eq on String', () => {
    expect(buildSearchFilter('exact', 'name', 'String', '_eq'))
      .toBe('filter: { name: { _eq: "exact" } }')
  })

  it('does not wrap value with % for _neq on String', () => {
    expect(buildSearchFilter('exact', 'name', 'String', '_neq'))
      .toBe('filter: { name: { _neq: "exact" } }')
  })

  it('coerces Int values to integer literals', () => {
    expect(buildSearchFilter('42', 'age', 'Int', '_eq'))
      .toBe('filter: { age: { _eq: 42 } }')
  })

  it('returns empty string for non-numeric Int input', () => {
    expect(buildSearchFilter('abc', 'age', 'Int')).toBe('')
  })

  it('coerces Float values to float literals', () => {
    expect(buildSearchFilter('3.14', 'score', 'Float', '_eq'))
      .toBe('filter: { score: { _eq: 3.14 } }')
  })

  it('returns empty string for non-numeric Float input', () => {
    expect(buildSearchFilter('xyz', 'score', 'Float')).toBe('')
  })

  it('coerces Boolean true to literal true', () => {
    expect(buildSearchFilter('true', 'active', 'Boolean', '_eq'))
      .toBe('filter: { active: { _eq: true } }')
  })

  it('coerces non-true Boolean to literal false', () => {
    expect(buildSearchFilter('yes', 'active', 'Boolean', '_eq'))
      .toBe('filter: { active: { _eq: false } }')
  })

  it('defaults Int to _eq operator', () => {
    const result = buildSearchFilter('5', 'count', 'Int')
    expect(result).toBe('filter: { count: { _eq: 5 } }')
  })

  it('trims leading/trailing whitespace from term', () => {
    expect(buildSearchFilter('  alice  ', 'name', 'String', '_eq'))
      .toBe('filter: { name: { _eq: "alice" } }')
  })
})

// ── buildDocumentsQuery ───────────────────────────────────────────────────────

describe('buildDocumentsQuery', () => {
  it('builds a basic query with fields and pagination', () => {
    const q = buildDocumentsQuery('Post', ['_docID', 'title'], 25, 0)
    expect(q).toContain('Post(')
    expect(q).toContain('limit: 25')
    expect(q).toContain('offset: 0')
    expect(q).toContain('_docID')
    expect(q).toContain('title')
  })

  it('includes filter arg when provided', () => {
    const filter = 'filter: { title: { _ilike: "%foo%" } }'
    const q = buildDocumentsQuery('Post', ['title'], 10, 0, filter)
    expect(q).toContain(filter)
  })

  it('omits filter arg when empty string', () => {
    const q = buildDocumentsQuery('Post', ['title'], 10, 0, '')
    expect(q).not.toContain('filter:')
  })

  it('applies correct offset for page 2', () => {
    const q = buildDocumentsQuery('Post', ['_docID'], 25, 25)
    expect(q).toContain('offset: 25')
  })

  it('renders each field on its own indented line', () => {
    const q = buildDocumentsQuery('User', ['_docID', 'name', 'age'], 10, 0)
    expect(q).toContain('    _docID')
    expect(q).toContain('    name')
    expect(q).toContain('    age')
  })
})

// ── buildCountQuery ───────────────────────────────────────────────────────────

describe('buildCountQuery', () => {
  it('builds a count query without filter', () => {
    expect(buildCountQuery('Post')).toBe('{ COUNT(Post: {}) }')
  })

  it('wraps filter arg inside COUNT when provided', () => {
    const filter = 'filter: { title: { _eq: "foo" } }'
    expect(buildCountQuery('Post', filter)).toBe(`{ COUNT(Post: { ${filter} }) }`)
  })
})

// ── buildAllCountsQuery ───────────────────────────────────────────────────────

describe('buildAllCountsQuery', () => {
  it('aliases each collection as its name', () => {
    const q = buildAllCountsQuery(['Post', 'User', 'Comment'])
    expect(q).toContain('Post: COUNT(Post: {})')
    expect(q).toContain('User: COUNT(User: {})')
    expect(q).toContain('Comment: COUNT(Comment: {})')
  })

  it('returns a valid GraphQL block', () => {
    const q = buildAllCountsQuery(['Post'])
    expect(q.trim()).toMatch(/^\{[\s\S]+\}$/)
  })

  it('handles a single collection', () => {
    expect(buildAllCountsQuery(['Foo'])).toBe('{\n  Foo: COUNT(Foo: {})\n}')
  })
})

// ── getBaseKind ───────────────────────────────────────────────────────────────

describe('getBaseKind', () => {
  it('returns kind for a direct type', () => {
    const t: IntrospectionTypeRef = { kind: 'SCALAR', name: 'String' }
    expect(getBaseKind(t)).toBe('SCALAR')
  })

  it('unwraps NON_NULL', () => {
    const t: IntrospectionTypeRef = { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } }
    expect(getBaseKind(t)).toBe('SCALAR')
  })

  it('unwraps LIST', () => {
    const t: IntrospectionTypeRef = { kind: 'LIST', ofType: { kind: 'OBJECT', name: 'Post' } }
    expect(getBaseKind(t)).toBe('OBJECT')
  })

  it('unwraps NON_NULL wrapping LIST wrapping OBJECT', () => {
    const t: IntrospectionTypeRef = {
      kind: 'NON_NULL',
      ofType: { kind: 'LIST', ofType: { kind: 'OBJECT', name: 'Post' } },
    }
    expect(getBaseKind(t)).toBe('OBJECT')
  })

  it('unwraps deeply nested wrappers', () => {
    const t: IntrospectionTypeRef = {
      kind: 'NON_NULL',
      ofType: { kind: 'LIST', ofType: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } } },
    }
    expect(getBaseKind(t)).toBe('SCALAR')
  })
})

// ── isScalarField ─────────────────────────────────────────────────────────────

describe('isScalarField', () => {
  it('returns true for a direct SCALAR', () => {
    expect(isScalarField({ kind: 'SCALAR', name: 'String' })).toBe(true)
  })

  it('returns true for NON_NULL SCALAR', () => {
    expect(isScalarField({ kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } })).toBe(true)
  })

  it('returns false for OBJECT', () => {
    expect(isScalarField({ kind: 'OBJECT', name: 'Post' })).toBe(false)
  })

  it('returns false for LIST of OBJECT', () => {
    expect(isScalarField({ kind: 'LIST', ofType: { kind: 'OBJECT', name: 'Post' } })).toBe(false)
  })
})

// ── sdlToCollectionPatch ──────────────────────────────────────────────────────

describe('sdlToCollectionPatch', () => {
  it('produces an "add" op for each field', () => {
    const sdl = `type User {\n  name: String\n  age: Int\n}`
    const patch = JSON.parse(sdlToCollectionPatch(sdl))
    expect(patch).toHaveLength(2)
    expect(patch[0]).toMatchObject({ op: 'add', path: '/User/Fields/-', value: { Name: 'name', Kind: 'String' } })
    expect(patch[1]).toMatchObject({ op: 'add', path: '/User/Fields/-', value: { Name: 'age', Kind: 'Int' } })
  })

  it('strips NonNull wrapper from field kind', () => {
    const sdl = `type Post {\n  title: String!\n}`
    const patch = JSON.parse(sdlToCollectionPatch(sdl))
    expect(patch[0].value.Kind).toBe('String')
  })

  it('strips List wrapper from field kind', () => {
    const sdl = `type Post {\n  tags: [String]\n}`
    const patch = JSON.parse(sdlToCollectionPatch(sdl))
    expect(patch[0].value.Kind).toBe('String')
  })

  it('throws when SDL has no type block', () => {
    expect(() => sdlToCollectionPatch('not valid sdl')).toThrow()
  })

  it('throws when type body has no parseable fields', () => {
    expect(() => sdlToCollectionPatch('type Empty {}')).toThrow('No fields found')
  })

  it('uses the correct type name in the patch path', () => {
    const sdl = `type BlogPost {\n  slug: String\n}`
    const patch = JSON.parse(sdlToCollectionPatch(sdl))
    expect(patch[0].path).toBe('/BlogPost/Fields/-')
  })
})
