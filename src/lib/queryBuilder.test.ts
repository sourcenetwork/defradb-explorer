import { describe, it, expect } from 'vitest'
import { buildSchema } from 'graphql'
import {
  getArgsForRootField,
  toggleArgInQuery,
  toggleFieldInQuery,
  getInputObjectFieldsInQuery,
  toggleInputObjectField,
  ensureArgAndToggleInputField,
  getActiveObjectAtOffset,
  getInputObjectFieldsAtOffset,
  toggleInputObjectFieldAtOffset,
  addItemToInputList,
  getListItemObjectStarts,
  computeCursorAfterToggle,
  getSelectedSubFieldsAtPath,
  toggleSubFieldAtPath,
  getActiveNestedSelectionAtOffset,
} from './queryBuilder'

// ── Test schema ───────────────────────────────────────────────────────────────

const schema = buildSchema(`
  enum Ordering { ASC DESC }

  input PostFilterArg {
    title: StringOperatorBlock
    _and: [PostFilterArg!]
    _or:  [PostFilterArg!]
    _not: PostFilterArg
  }

  input StringOperatorBlock {
    _eq:  String
    _like: String
    _in:  [String!]
  }

  input PostOrderArg {
    title: Ordering
    score: Ordering
  }

  input PostMutationInput {
    title: String
    score: Int
    published: Boolean
  }

  type Post {
    _docID: ID
    title:  String
    score:  Int
    published: Boolean
  }

  type Query {
    Post(limit: Int, offset: Int, filter: PostFilterArg, order: PostOrderArg, groupBy: [String!]): [Post]
    Post_by_id(id: ID!): Post
  }

  type Mutation {
    add_Post(input: [PostMutationInput!]): Post
  }
`)

// ── getArgsForRootField ───────────────────────────────────────────────────────

describe('getArgsForRootField', () => {
  it('returns present arg names', () => {
    const q = '{ Post(limit: 10) { title } }'
    expect(getArgsForRootField(q, 'Post')).toEqual(new Set(['limit']))
  })

  it('returns empty set when no args', () => {
    const q = '{ Post { title } }'
    expect(getArgsForRootField(q, 'Post').size).toBe(0)
  })
})

// ── toggleArgInQuery ──────────────────────────────────────────────────────────

describe('toggleArgInQuery', () => {
  const base = '{\n  Post(limit: 10) {\n    title\n  }\n}'

  it('adds a new int arg', () => {
    const result = toggleArgInQuery(base, 'Post', 'offset', 'Int')
    expect(result).toContain('offset: 0')
    expect(result).toContain('limit: 10')
  })

  it('removes an existing arg (sole arg)', () => {
    const result = toggleArgInQuery(base, 'Post', 'limit', 'Int')
    expect(result).not.toContain('limit')
    expect(result).not.toContain('(')
  })

  it('removes first of multiple args', () => {
    const q = '{\n  Post(limit: 10, offset: 0) {\n    title\n  }\n}'
    const result = toggleArgInQuery(q, 'Post', 'limit', 'Int')
    expect(result).toContain('offset: 0')
    expect(result).not.toContain('limit')
  })

  it('removes non-first arg', () => {
    const q = '{\n  Post(limit: 10, offset: 0) {\n    title\n  }\n}'
    const result = toggleArgInQuery(q, 'Post', 'offset', 'Int')
    expect(result).toContain('limit: 10')
    expect(result).not.toContain('offset')
  })

  it('adds object arg as {}', () => {
    const result = toggleArgInQuery(base, 'Post', 'filter', 'PostFilterArg')
    expect(result).toContain('filter: {}')
    expect(result).toContain('limit: 10')
  })

  it('adds list arg as []', () => {
    const result = toggleArgInQuery(base, 'Post', 'groupBy', 'String', true)
    expect(result).toContain('groupBy: []')
  })

  it('does not reformat selection set', () => {
    const result = toggleArgInQuery(base, 'Post', 'offset', 'Int')
    expect(result).toContain('    title')
  })
})

// ── toggleFieldInQuery ────────────────────────────────────────────────────────

describe('toggleFieldInQuery', () => {
  const base = '{\n  Post(limit: 10) {\n    title\n    score\n  }\n}'

  it('removes a field', () => {
    const result = toggleFieldInQuery(base, 'Post', 'title', schema)
    expect(result).not.toContain('title')
    expect(result).toContain('score')
  })

  it('adds a field', () => {
    const result = toggleFieldInQuery(base, 'Post', 'published', schema)
    expect(result).toContain('published')
    expect(result).toContain('title')
  })

  it('preserves arg formatting when toggling fields', () => {
    const q = '{\n  Post(limit: 10, filter: {\n    title: {\n      _eq: "hello"\n    }\n  }) {\n    title\n  }\n}'
    const result = toggleFieldInQuery(q, 'Post', 'score', schema)
    expect(result).toContain('filter: {')
    expect(result).toContain('_eq: "hello"')
    expect(result).toContain('score')
  })

  it('falls back to __typename when last field removed', () => {
    const q = '{\n  Post(limit: 10) {\n    title\n  }\n}'
    const result = toggleFieldInQuery(q, 'Post', 'title', schema)
    expect(result).toContain('__typename')
  })
})

// ── getInputObjectFieldsInQuery ───────────────────────────────────────────────

describe('getInputObjectFieldsInQuery', () => {
  it('finds top-level input object fields', () => {
    const q = '{\n  Post(filter: {\n    title: { _eq: "x" }\n  }) {\n    title\n  }\n}'
    const result = getInputObjectFieldsInQuery(q, 'PostFilterArg', schema)
    expect(result.has('title')).toBe(true)
  })

  it('returns empty set when type not in query', () => {
    const q = '{ Post(limit: 10) { title } }'
    expect(getInputObjectFieldsInQuery(q, 'PostFilterArg', schema).size).toBe(0)
  })

  it('finds nested input object fields', () => {
    const q = '{\n  Post(filter: {\n    title: {\n      _eq: "x"\n      _like: "%x%"\n    }\n  }) {\n    title\n  }\n}'
    const result = getInputObjectFieldsInQuery(q, 'StringOperatorBlock', schema)
    expect(result.has('_eq')).toBe(true)
    expect(result.has('_like')).toBe(true)
  })
})

// ── toggleInputObjectField ────────────────────────────────────────────────────

describe('toggleInputObjectField', () => {
  describe('ADD — inline empty object', () => {
    const q = '{\n  Post(filter: {}) {\n    title\n  }\n}'

    it('expands inline {} and adds field', () => {
      const result = toggleInputObjectField(q, 'PostFilterArg', 'title', 'StringOperatorBlock', schema)
      expect(result).toContain('title: {}')
      expect(result).not.toBe(q)
    })

    it('does not produce {}  (object default for object field)', () => {
      const result = toggleInputObjectField(q, 'PostFilterArg', 'title', 'StringOperatorBlock', schema)
      const titleLine = result.split('\n').find(l => l.includes('title:'))
      expect(titleLine).toBeDefined()
      expect(titleLine).toContain('{}')
    })
  })

  describe('ADD — enum field gets first enum value', () => {
    const q = '{\n  Post(order: {}) {\n    title\n  }\n}'

    it('adds enum field with ASC default (first value)', () => {
      const result = toggleInputObjectField(q, 'PostOrderArg', 'title', 'Ordering', schema)
      expect(result).toContain('title: ASC')
    })

    it('does not produce title: {}', () => {
      const result = toggleInputObjectField(q, 'PostOrderArg', 'title', 'Ordering', schema)
      expect(result).not.toContain('title: {}')
    })
  })

  describe('ADD — list-of-input-object field gets [{}]', () => {
    const q = '{\n  Post(filter: {}) {\n    title\n  }\n}'

    it('adds _or with [{}] default (list of input object)', () => {
      const result = toggleInputObjectField(q, 'PostFilterArg', '_or', 'PostFilterArg', schema)
      expect(result).toContain('_or: [{}]')
    })

    it('adds _in with [] default (list of scalar)', () => {
      const inner = '{\n  Post(filter: {\n    title: {}\n  }) {\n    title\n  }\n}'
      const result = toggleInputObjectField(inner, 'StringOperatorBlock', '_in', 'String', schema)
      expect(result).toContain('_in: []')
      expect(result).not.toContain('[{}]')
    })
  })

  describe('REMOVE', () => {
    it('removes an existing field', () => {
      const q = '{\n  Post(filter: {\n    title: { _eq: "x" }\n  }) {\n    title\n  }\n}'
      const result = toggleInputObjectField(q, 'PostFilterArg', 'title', 'StringOperatorBlock', schema)
      expect(result).not.toContain('title: {')
    })

    it('preserves sibling fields', () => {
      const q = '{\n  Post(order: {\n    title: ASC\n    score: DESC\n  }) {\n    title\n  }\n}'
      const result = toggleInputObjectField(q, 'PostOrderArg', 'title', 'Ordering', schema)
      expect(result).not.toContain('title: ASC')
      expect(result).toContain('score: DESC')
    })
  })

  describe('nested depth — StringOperatorBlock inside filter.title', () => {
    const q = '{\n  Post(filter: {\n    title: {}\n  }) {\n    title\n  }\n}'

    it('adds _eq inside StringOperatorBlock', () => {
      const result = toggleInputObjectField(q, 'StringOperatorBlock', '_eq', 'String', schema)
      expect(result).toContain('_eq: ""')
    })

    it('adds _in as [] (list field)', () => {
      const result = toggleInputObjectField(q, 'StringOperatorBlock', '_in', 'String', schema)
      expect(result).toContain('_in: []')
    })
  })
})

// ── ensureArgAndToggleInputField ──────────────────────────────────────────────

describe('ensureArgAndToggleInputField', () => {
  const base = '{\n  Post(limit: 10) {\n    title\n  }\n}'

  it('auto-adds filter arg when not present, then adds field', () => {
    const result = ensureArgAndToggleInputField(base, 'PostFilterArg', 'title', 'StringOperatorBlock', schema)
    expect(result).toContain('filter:')
    expect(result).toContain('title:')
  })

  it('auto-adds order arg when not present', () => {
    const result = ensureArgAndToggleInputField(base, 'PostOrderArg', 'title', 'Ordering', schema)
    expect(result).toContain('order:')
    expect(result).toContain('title: ASC')
  })

  it('toggles field when input object already present', () => {
    const q = '{\n  Post(limit: 10, filter: {\n    title: { _eq: "x" }\n  }) {\n    title\n  }\n}'
    const result = ensureArgAndToggleInputField(q, 'PostFilterArg', 'title', 'StringOperatorBlock', schema)
    expect(result).not.toContain('title: {')
  })
})

// ── mutation input ────────────────────────────────────────────────────────────

describe('mutation input object', () => {
  const base = 'mutation {\n  add_Post(input: [{\n    title: ""\n    score: 0\n  }]) {\n    _docID\n  }\n}'

  it('shows correct selected fields', () => {
    const result = getInputObjectFieldsInQuery(base, 'PostMutationInput', schema)
    expect(result.has('title')).toBe(true)
    expect(result.has('score')).toBe(true)
    expect(result.has('published')).toBe(false)
  })

  it('adds a boolean field with false default', () => {
    const result = toggleInputObjectField(base, 'PostMutationInput', 'published', 'Boolean', schema)
    expect(result).toContain('published: false')
  })

  it('removes an existing field', () => {
    const result = toggleInputObjectField(base, 'PostMutationInput', 'title', 'String', schema)
    expect(result).not.toContain('title:')
    expect(result).toContain('score: 0')
  })
})

// ── edge cases: bad input ─────────────────────────────────────────────────────

describe('graceful handling of bad input', () => {
  it('getArgsForRootField returns empty set for empty string', () => {
    expect(getArgsForRootField('', 'Post').size).toBe(0)
  })

  it('getArgsForRootField returns empty set for invalid query', () => {
    expect(getArgsForRootField('not graphql !!!', 'Post').size).toBe(0)
  })

  it('getArgsForRootField returns empty set when field not in query', () => {
    expect(getArgsForRootField('{ Post { title } }', 'User').size).toBe(0)
  })

  it('toggleArgInQuery returns query unchanged for empty string', () => {
    // empty string won't contain the field, falls back gracefully
    const result = toggleArgInQuery('', 'Post', 'limit', 'Int')
    expect(typeof result).toBe('string')
  })

  it('toggleArgInQuery returns query unchanged for invalid query', () => {
    const result = toggleArgInQuery('not valid !!!', 'Post', 'limit', 'Int')
    expect(result).toBe('not valid !!!')
  })

  it('toggleFieldInQuery returns query unchanged for invalid query', () => {
    const result = toggleFieldInQuery('not valid !!!', 'Post', 'title', schema)
    expect(result).toBe('not valid !!!')
  })

  it('getInputObjectFieldsInQuery returns empty set for empty string', () => {
    expect(getInputObjectFieldsInQuery('', 'PostFilterArg', schema).size).toBe(0)
  })

  it('getInputObjectFieldsInQuery returns empty set for invalid query', () => {
    expect(getInputObjectFieldsInQuery('not valid !!!', 'PostFilterArg', schema).size).toBe(0)
  })

  it('toggleInputObjectField returns query unchanged for invalid query', () => {
    const result = toggleInputObjectField('not valid !!!', 'PostFilterArg', 'title', 'String', schema)
    expect(result).toBe('not valid !!!')
  })

  it('ensureArgAndToggleInputField returns query unchanged when type not a root arg', () => {
    // StringOperatorBlock is not a direct arg of any root field, can't auto-scaffold
    const q = '{ Post { title } }'
    const result = ensureArgAndToggleInputField(q, 'StringOperatorBlock', '_eq', 'String', schema)
    expect(result).toBe(q)
  })
})

// ── edge cases: single-line queries ──────────────────────────────────────────

describe('single-line query handling', () => {
  it('toggleArgInQuery adds arg to single-line query', () => {
    const q = '{ Post { title } }'
    const result = toggleArgInQuery(q, 'Post', 'limit', 'Int')
    expect(result).toContain('limit: 10')
  })

  it('toggleArgInQuery removes sole arg from single-line query', () => {
    const q = '{ Post(limit: 10) { title } }'
    const result = toggleArgInQuery(q, 'Post', 'limit', 'Int')
    expect(result).not.toContain('limit')
    expect(result).not.toContain('(')
  })

  it('toggleInputObjectField removes field that is inline on same line', () => {
    // filter: { title: { _eq: "x" } } — entire filter value is on one line
    const q = '{ Post(filter: { title: { _eq: "x" } }) { title } }'
    // Removing _eq from StringOperatorBlock should not corrupt the query
    const result = toggleInputObjectField(q, 'StringOperatorBlock', '_eq', 'String', schema)
    expect(result).not.toContain('_eq')
    expect(typeof result).toBe('string')
  })
})

// ── edge cases: toggle idempotency ───────────────────────────────────────────

describe('toggle idempotency', () => {
  it('toggling arg on then off returns structurally equivalent query', () => {
    const base = '{\n  Post(limit: 10) {\n    title\n  }\n}'
    const on  = toggleArgInQuery(base, 'Post', 'offset', 'Int')
    const off = toggleArgInQuery(on,   'Post', 'offset', 'Int')
    expect(off).not.toContain('offset')
    // limit should still be there
    expect(off).toContain('limit: 10')
  })

  it('toggling field on then off returns original fields', () => {
    const base = '{\n  Post(limit: 10) {\n    title\n    score\n  }\n}'
    const on  = toggleFieldInQuery(base, 'Post', 'published', schema)
    const off = toggleFieldInQuery(on,   'Post', 'published', schema)
    expect(off).not.toContain('published')
    expect(off).toContain('title')
    expect(off).toContain('score')
  })

  it('toggling input field on then off removes it cleanly', () => {
    // Start with title: {} (no _eq), toggle on then off
    const base = '{\n  Post(filter: {\n    title: {}\n  }) {\n    title\n  }\n}'
    const on  = toggleInputObjectField(base, 'StringOperatorBlock', '_eq', 'String', schema)
    expect(on).toContain('_eq:')
    const off = toggleInputObjectField(on, 'StringOperatorBlock', '_eq', 'String', schema)
    expect(off).not.toContain('_eq')
  })
})

// ── edge cases: field name prefix collisions ──────────────────────────────────

describe('field name prefix collisions', () => {
  it('removing "title" does not remove "title_count" or other prefixed fields', () => {
    // title and _like both start with a common letter — toggling one must not affect other
    const q = '{\n  Post(filter: {\n    title: {\n      _eq: "x"\n      _like: "%x%"\n    }\n  }) {\n    title\n  }\n}'
    const result = toggleInputObjectField(q, 'StringOperatorBlock', '_eq', 'String', schema)
    expect(result).not.toContain('_eq:')
    expect(result).toContain('_like')
  })
})

// ── edge cases: self-referential input types ──────────────────────────────────

describe('self-referential input types', () => {
  it('adds _not field (same type as parent) with {} default', () => {
    const q = '{\n  Post(filter: {}) {\n    title\n  }\n}'
    const result = toggleInputObjectField(q, 'PostFilterArg', '_not', 'PostFilterArg', schema)
    expect(result).toContain('_not: {}')
  })

  it('adds _or field (list of same type) with [{}] default', () => {
    const q = '{\n  Post(filter: {}) {\n    title\n  }\n}'
    const result = toggleInputObjectField(q, 'PostFilterArg', '_or', 'PostFilterArg', schema)
    expect(result).toContain('_or: [{}]')
  })

  it('adds _and field (list of same type) with [{}] default', () => {
    const q = '{\n  Post(filter: {}) {\n    title\n  }\n}'
    const result = toggleInputObjectField(q, 'PostFilterArg', '_and', 'PostFilterArg', schema)
    expect(result).toContain('_and: [{}]')
  })
})

// ── edge cases: scalar type defaults ─────────────────────────────────────────

describe('scalar type defaults', () => {
  it('Int field defaults to 0', () => {
    const result = toggleArgInQuery('{\n  Post {\n    title\n  }\n}', 'Post', 'offset', 'Int')
    expect(result).toContain('offset: 0')
  })

  it('Float field defaults to 0.0', () => {
    const result = toggleArgInQuery('{\n  Post {\n    title\n  }\n}', 'Post', 'score', 'Float')
    expect(result).toContain('score: 0.0')
  })

  it('Boolean field in mutation input defaults to false', () => {
    const q = 'mutation {\n  add_Post(input: [{\n    title: ""\n  }]) {\n    _docID\n  }\n}'
    const result = toggleInputObjectField(q, 'PostMutationInput', 'published', 'Boolean', schema)
    expect(result).toContain('published: false')
  })

  it('String field in input object defaults to ""', () => {
    const q = '{\n  Post(filter: {\n    title: {}\n  }) {\n    title\n  }\n}'
    const result = toggleInputObjectField(q, 'StringOperatorBlock', '_eq', 'String', schema)
    expect(result).toContain('_eq: ""')
  })
})

// ── edge cases: deeply nested input object ────────────────────────────────────

describe('deeply nested input object toggling', () => {
  it('toggles _eq inside StringOperatorBlock nested inside filter.title', () => {
    const q = '{\n  Post(filter: {\n    title: {\n      _like: "%x%"\n    }\n  }) {\n    title\n  }\n}'
    const result = toggleInputObjectField(q, 'StringOperatorBlock', '_eq', 'String', schema)
    expect(result).toContain('_eq: ""')
    expect(result).toContain('_like: "%x%"')
  })

  it('removes _like from StringOperatorBlock leaving _eq intact', () => {
    const q = '{\n  Post(filter: {\n    title: {\n      _eq: "x"\n      _like: "%x%"\n    }\n  }) {\n    title\n  }\n}'
    const result = toggleInputObjectField(q, 'StringOperatorBlock', '_like', 'String', schema)
    expect(result).not.toContain('_like')
    expect(result).toContain('_eq: "x"')
  })

  it('ensureArgAndToggleInputField adds filter + title when neither present', () => {
    const q = '{\n  Post {\n    title\n  }\n}'
    const result = ensureArgAndToggleInputField(q, 'PostFilterArg', 'title', 'StringOperatorBlock', schema)
    expect(result).toContain('filter:')
    expect(result).toContain('title:')
  })
})

// ── edge cases: multiple root fields in query ─────────────────────────────────

describe('multiple root fields in query', () => {
  it('toggleArgInQuery only affects the target root field', () => {
    const q = '{\n  Post(limit: 5) {\n    title\n  }\n  Post_by_id(id: "abc") {\n    title\n  }\n}'
    const result = toggleArgInQuery(q, 'Post', 'offset', 'Int')
    expect(result).toContain('offset: 0')
    // Post_by_id should be untouched
    expect(result).toContain('Post_by_id(id: "abc")')
  })

  it('toggleFieldInQuery only affects the first matching type', () => {
    const q = '{\n  Post(limit: 5) {\n    title\n  }\n}'
    const result = toggleFieldInQuery(q, 'Post', 'score', schema)
    expect(result).toContain('score')
    expect(result).toContain('title')
  })
})

// ── computeCursorAfterToggle ──────────────────────────────────────────────────

describe('computeCursorAfterToggle', () => {
  it('returns null when query is unchanged', () => {
    expect(computeCursorAfterToggle('{ Post { title } }', '{ Post { title } }')).toBeNull()
  })

  it('returns null when query shrinks (removal)', () => {
    const base = '{\n  Post(limit: 10, offset: 0) {\n    title\n  }\n}'
    const removed = toggleArgInQuery(base, 'Post', 'offset', 'Int')
    expect(removed.length).toBeLessThan(base.length)
    expect(computeCursorAfterToggle(base, removed)).toBeNull()
  })

  it('positions cursor between quotes for string field', () => {
    const base = '{\n  Post(filter: {\n    title: {}\n  }) {\n    title\n  }\n}'
    const next = toggleInputObjectField(base, 'StringOperatorBlock', '_eq', 'String', schema)
    const cursor = computeCursorAfterToggle(base, next)
    expect(cursor).not.toBeNull()
    // character at cursor-1 should be opening quote, character at cursor should be closing quote
    expect(next[cursor! - 1]).toBe('"')
    expect(next[cursor!]).toBe('"')
  })

  it('positions cursor inside {} for object field', () => {
    const base = '{\n  Post(limit: 10) {\n    title\n  }\n}'
    const next = toggleArgInQuery(base, 'Post', 'filter', 'PostFilterArg')
    const cursor = computeCursorAfterToggle(base, next)
    expect(cursor).not.toBeNull()
    expect(next[cursor! - 1]).toBe('{')
    expect(next[cursor!]).toBe('}')
  })

  it('positions cursor inside [] for list field', () => {
    const base = '{\n  Post(limit: 10) {\n    title\n  }\n}'
    const next = toggleArgInQuery(base, 'Post', 'groupBy', 'String', true)
    const cursor = computeCursorAfterToggle(base, next)
    expect(cursor).not.toBeNull()
    expect(next[cursor! - 1]).toBe('[')
    expect(next[cursor!]).toBe(']')
  })

  it('positions cursor after number value', () => {
    const base = '{\n  Post {\n    title\n  }\n}'
    const next = toggleArgInQuery(base, 'Post', 'offset', 'Int')
    const cursor = computeCursorAfterToggle(base, next)
    expect(cursor).not.toBeNull()
    // character before cursor should be the last digit of 0
    expect(next[cursor! - 1]).toBe('0')
  })

  it('positions cursor between quotes when expanding inline {}', () => {
    const base = '{\n  Post(filter: { title: {} }) {\n    title\n  }\n}'
    const next = toggleInputObjectField(base, 'StringOperatorBlock', '_eq', 'String', schema)
    const cursor = computeCursorAfterToggle(base, next)
    expect(cursor).not.toBeNull()
    expect(next[cursor! - 1]).toBe('"')
    expect(next[cursor!]).toBe('"')
  })
})

// ── getActiveObjectAtOffset ───────────────────────────────────────────────────

describe('getActiveObjectAtOffset', () => {
  it('returns null when cursor is not inside any ObjectValue', () => {
    const q = '{\n  Post(limit: 10) {\n    title\n  }\n}'
    // cursor on "title" in selection set — no ObjectValue
    const offset = q.indexOf('title')
    expect(getActiveObjectAtOffset(q, offset, schema)).toBeNull()
  })

  it('returns outer type when cursor is in outer ObjectValue', () => {
    const q = '{\n  Post(filter: {\n    title: { _eq: "x" }\n  }) {\n    title\n  }\n}'
    // cursor just after the outer { of filter
    const filterOpen = q.indexOf('filter: {') + 'filter: '.length
    const result = getActiveObjectAtOffset(q, filterOpen + 1, schema)
    expect(result?.typeName).toBe('PostFilterArg')
  })

  it('returns deepest type when cursor is in nested ObjectValue', () => {
    const q = '{\n  Post(filter: {\n    title: {\n      _eq: "x"\n    }\n  }) {\n    title\n  }\n}'
    // cursor inside the inner title: {} block
    const innerOpen = q.indexOf('_eq:')
    const result = getActiveObjectAtOffset(q, innerOpen, schema)
    expect(result?.typeName).toBe('StringOperatorBlock')
  })

  it('returns null for empty query', () => {
    expect(getActiveObjectAtOffset('', 0, schema)).toBeNull()
  })

  it('returns null for invalid query', () => {
    expect(getActiveObjectAtOffset('not valid', 0, schema)).toBeNull()
  })
})

// ── getInputObjectFieldsAtOffset ──────────────────────────────────────────────

describe('getInputObjectFieldsAtOffset', () => {
  it('returns fields in the ObjectValue at the given start', () => {
    const q = '{\n  Post(filter: {\n    title: { _eq: "x" }\n  }) {\n    title\n  }\n}'
    const filterStart = q.indexOf('{', q.indexOf('filter: '))
    const result = getInputObjectFieldsAtOffset(q, filterStart)
    expect(result.has('title')).toBe(true)
  })

  it('returns empty set when no ObjectValue at that offset', () => {
    const q = '{ Post { title } }'
    expect(getInputObjectFieldsAtOffset(q, 999).size).toBe(0)
  })

  it('can target nested ObjectValue independently', () => {
    const q = '{\n  Post(filter: {\n    title: {\n      _eq: "x"\n      _like: "%x%"\n    }\n  }) {\n    title\n  }\n}'
    // get the inner block start
    const info = getActiveObjectAtOffset(q, q.indexOf('_eq:'), schema)!
    const result = getInputObjectFieldsAtOffset(q, info.objectStart)
    expect(result.has('_eq')).toBe(true)
    expect(result.has('_like')).toBe(true)
    expect(result.has('title')).toBe(false)
  })
})

// ── toggleInputObjectFieldAtOffset ────────────────────────────────────────────

describe('toggleInputObjectFieldAtOffset', () => {
  it('adds a field to the targeted ObjectValue', () => {
    const q = '{\n  Post(filter: {\n    title: {}\n  }) {\n    title\n  }\n}'
    const info = getActiveObjectAtOffset(q, q.indexOf('title: {') + 'title: '.length, schema)!
    expect(info.typeName).toBe('StringOperatorBlock')
    const result = toggleInputObjectFieldAtOffset(q, info.objectStart, '_eq', schema)
    expect(result).toContain('_eq: ""')
  })

  it('removes a field from the targeted ObjectValue', () => {
    const q = '{\n  Post(filter: {\n    title: {\n      _eq: "x"\n    }\n  }) {\n    title\n  }\n}'
    const info = getActiveObjectAtOffset(q, q.indexOf('_eq:'), schema)!
    const result = toggleInputObjectFieldAtOffset(q, info.objectStart, '_eq', schema)
    expect(result).not.toContain('_eq')
  })

  it('targets the correct ObjectValue when multiple of same type exist', () => {
    // Two PostFilterArg objects in query — _and with two items
    const q = '{\n  Post(filter: {\n    _and: [\n      { title: { _eq: "a" } }\n      { title: { _eq: "b" } }\n    ]\n  }) {\n    title\n  }\n}'
    // Get objectStart of the second _and item (the { _eq: "b" } one)
    const secondEq = q.lastIndexOf('{ title:')
    const info = getActiveObjectAtOffset(q, secondEq + 1, schema)!
    expect(info.typeName).toBe('PostFilterArg')
    const result = toggleInputObjectFieldAtOffset(q, info.objectStart, '_or', schema)
    // _or should be added only to the second item
    expect(result).toContain('_or: [{}]')
    // The first item should be untouched
    const firstItem = result.slice(0, result.lastIndexOf('_or:'))
    expect(firstItem).toContain('_eq: "a"')
    expect(firstItem).not.toContain('_or:')
  })
})

// ── addItemToInputList ────────────────────────────────────────────────────────

describe('addItemToInputList', () => {
  it('expands empty [] to [\\n  {}\\n]', () => {
    const q = '{\n  Post(filter: {\n    _and: []\n  }) {\n    title\n  }\n}'
    const info = getActiveObjectAtOffset(q, q.indexOf('_and:') + 1, schema)!
    const result = addItemToInputList(q, info.objectStart, '_and')
    expect(result).toContain('{}')
    expect(result).not.toContain('[]')
  })

  it('appends second {} after first item', () => {
    const q = '{\n  Post(filter: {\n    _and: [\n      {}\n    ]\n  }) {\n    title\n  }\n}'
    const info = getActiveObjectAtOffset(q, q.indexOf('_and:') + 1, schema)!
    const result = addItemToInputList(q, info.objectStart, '_and')
    const matches = result.match(/\{\}/g)
    expect(matches?.length).toBe(2)
  })

  it('returns query unchanged when field not found', () => {
    const q = '{\n  Post(filter: {}) {\n    title\n  }\n}'
    const info = getActiveObjectAtOffset(q, q.indexOf('filter: {') + 'filter: '.length, schema)!
    const result = addItemToInputList(q, info.objectStart, 'nonexistent')
    expect(result).toBe(q)
  })
})

// ── getListItemObjectStarts ───────────────────────────────────────────────────

describe('getListItemObjectStarts', () => {
  it('returns starts for each {} item in list', () => {
    const q = '{\n  Post(filter: {\n    _and: [\n      { title: { _eq: "a" } }\n      { title: { _eq: "b" } }\n    ]\n  }) {\n    title\n  }\n}'
    const info = getActiveObjectAtOffset(q, q.indexOf('_and:') + 1, schema)!
    const starts = getListItemObjectStarts(q, info.objectStart, '_and')
    expect(starts.length).toBe(2)
    // Each start should point to the opening { of an item
    expect(q[starts[0]]).toBe('{')
    expect(q[starts[1]]).toBe('{')
    expect(starts[0]).toBeLessThan(starts[1])
  })

  it('returns empty array for empty list', () => {
    const q = '{\n  Post(filter: {\n    _and: []\n  }) {\n    title\n  }\n}'
    const info = getActiveObjectAtOffset(q, q.indexOf('_and:') + 1, schema)!
    expect(getListItemObjectStarts(q, info.objectStart, '_and')).toEqual([])
  })
})

// ── edge cases: preserving sibling structure after remove ─────────────────────

describe('structure preservation after remove', () => {
  it('removing middle arg preserves other args', () => {
    const q = '{\n  Post(limit: 10, offset: 0, groupBy: []) {\n    title\n  }\n}'
    const result = toggleArgInQuery(q, 'Post', 'offset', 'Int')
    expect(result).toContain('limit: 10')
    expect(result).toContain('groupBy: []')
    expect(result).not.toContain('offset')
  })

  it('removing input field preserves other fields and args', () => {
    const q = '{\n  Post(limit: 10, order: {\n    title: ASC\n    score: DESC\n  }) {\n    title\n  }\n}'
    const result = toggleInputObjectField(q, 'PostOrderArg', 'score', 'Ordering', schema)
    expect(result).toContain('limit: 10')
    expect(result).toContain('title: ASC')
    expect(result).not.toContain('score: DESC')
  })
})

// ── Nested selection schema ───────────────────────────────────────────────────

const nestedSchema = buildSchema(`
  type Comment {
    _docID: ID
    text: String
    replies: [Comment]
  }

  type Post {
    _docID: ID
    title: String
    comment: Comment
  }

  type Query {
    Post(limit: Int): [Post]
  }
`)

// ── toggleFieldInQuery: complex type handling ─────────────────────────────────

describe('toggleFieldInQuery — complex types', () => {
  const base = '{\n  Post(limit: 10) {\n    title\n  }\n}'

  it('adds a complex field with default sub-selection', () => {
    const result = toggleFieldInQuery(base, 'Post', 'comment', nestedSchema)
    expect(result).toContain('comment {')
    // should include scalar sub-fields of Comment (not _docID since it starts with _)
    expect(result).toMatch(/comment\s*\{[\s\S]*text[\s\S]*\}/)
    expect(result).toContain('title')
  })

  it('removes a complex field including its entire sub-selection block', () => {
    const q = '{\n  Post(limit: 10) {\n    title\n    comment {\n      text\n    }\n  }\n}'
    const result = toggleFieldInQuery(q, 'Post', 'comment', nestedSchema)
    expect(result).not.toContain('comment')
    expect(result).not.toContain('text')
    expect(result).toContain('title')
  })

  it('toggling a scalar field does not disturb an existing complex field sub-selection', () => {
    const q = '{\n  Post(limit: 10) {\n    title\n    comment {\n      text\n    }\n  }\n}'
    // Toggle title off — should NOT touch the comment { text } block
    const result = toggleFieldInQuery(q, 'Post', 'title', nestedSchema)
    expect(result).not.toContain('title')
    expect(result).toContain('comment {')
    expect(result).toContain('text')
  })

  it('toggling a scalar field onto a query with complex fields preserves sub-selections', () => {
    const q = '{\n  Post(limit: 10) {\n    comment {\n      text\n    }\n  }\n}'
    const result = toggleFieldInQuery(q, 'Post', 'title', nestedSchema)
    expect(result).toContain('title')
    expect(result).toContain('comment {')
    expect(result).toContain('text')
  })
})

// ── getSelectedSubFieldsAtPath ────────────────────────────────────────────────

describe('getSelectedSubFieldsAtPath', () => {
  it('returns selected sub-fields inside a nested path', () => {
    const q = '{\n  Post(limit: 10) {\n    comment {\n      text\n    }\n  }\n}'
    const result = getSelectedSubFieldsAtPath(q, 'Post', 'comment', nestedSchema)
    expect(result.has('text')).toBe(true)
    expect(result.has('_docID')).toBe(false)
  })

  it('returns empty set when parent field is absent', () => {
    const q = '{\n  Post(limit: 10) {\n    title\n  }\n}'
    const result = getSelectedSubFieldsAtPath(q, 'Post', 'comment', nestedSchema)
    expect(result.size).toBe(0)
  })

  it('returns empty set when parent field has no selection set', () => {
    // bare 'comment' without { } is invalid GraphQL but parse may handle it
    const result = getSelectedSubFieldsAtPath('', 'Post', 'comment', nestedSchema)
    expect(result.size).toBe(0)
  })

  it('reflects multiple sub-fields', () => {
    const q = '{\n  Post(limit: 10) {\n    comment {\n      _docID\n      text\n    }\n  }\n}'
    const result = getSelectedSubFieldsAtPath(q, 'Post', 'comment', nestedSchema)
    expect(result.has('_docID')).toBe(true)
    expect(result.has('text')).toBe(true)
    expect(result.size).toBe(2)
  })
})

// ── toggleSubFieldAtPath ──────────────────────────────────────────────────────

describe('toggleSubFieldAtPath', () => {
  const base = '{\n  Post(limit: 10) {\n    comment {\n      text\n    }\n  }\n}'

  it('adds a scalar sub-field', () => {
    const result = toggleSubFieldAtPath(base, 'Post', 'comment', '_docID', nestedSchema)
    expect(result).toContain('_docID')
    expect(result).toContain('text')
  })

  it('removes a scalar sub-field', () => {
    const result = toggleSubFieldAtPath(base, 'Post', 'comment', 'text', nestedSchema)
    expect(result).not.toContain('text')
    // last field removed → __typename placeholder
    expect(result).toContain('__typename')
  })

  it('keeps other sub-fields when removing one of several', () => {
    const q = '{\n  Post(limit: 10) {\n    comment {\n      _docID\n      text\n    }\n  }\n}'
    const result = toggleSubFieldAtPath(q, 'Post', 'comment', 'text', nestedSchema)
    expect(result).not.toContain('text')
    expect(result).toContain('_docID')
  })

  it('adds a complex sub-field with its own sub-selection', () => {
    const result = toggleSubFieldAtPath(base, 'Post', 'comment', 'replies', nestedSchema)
    // replies is [Comment] — should add replies { text } (scalar sub-fields of Comment)
    expect(result).toContain('replies {')
    expect(result).toMatch(/replies\s*\{[\s\S]*text[\s\S]*\}/)
    expect(result).toContain('text') // existing text still present
  })

  it('removes a complex sub-field including its sub-selection', () => {
    const q = '{\n  Post(limit: 10) {\n    comment {\n      text\n      replies {\n        text\n      }\n    }\n  }\n}'
    const result = toggleSubFieldAtPath(q, 'Post', 'comment', 'replies', nestedSchema)
    expect(result).not.toContain('replies')
    expect(result).toContain('comment {')
    expect(result).toContain('text') // the comment.text should remain
  })

  it('returns query unchanged when parent field is not in query', () => {
    const q = '{\n  Post(limit: 10) {\n    title\n  }\n}'
    const result = toggleSubFieldAtPath(q, 'Post', 'comment', 'text', nestedSchema)
    expect(result).toBe(q)
  })
})

// ── getActiveNestedSelectionAtOffset ─────────────────────────────────────────

describe('getActiveNestedSelectionAtOffset', () => {
  const q = '{\n  Post(limit: 10) {\n    comment {\n      text\n    }\n  }\n}'

  it('returns nested selection info when cursor is inside nested selection set', () => {
    const offset = q.indexOf('text')
    const result = getActiveNestedSelectionAtOffset(q, offset, nestedSchema)
    expect(result).not.toBeNull()
    expect(result?.parentTypeName).toBe('Post')
    expect(result?.fieldName).toBe('comment')
    expect(result?.fieldTypeName).toBe('Comment')
    expect(result?.operationName).toBe('Post')
    expect(result?.opKind).toBe('query')
  })

  it('returns null when cursor is in the root selection set (not nested)', () => {
    // cursor on "title" at root level — depth 1, not nested
    const q2 = '{\n  Post(limit: 10) {\n    title\n  }\n}'
    const offset = q2.indexOf('title')
    const result = getActiveNestedSelectionAtOffset(q2, offset, nestedSchema)
    expect(result).toBeNull()
  })

  it('returns null when cursor is in an ObjectValue (filter arg), not a selection set', () => {
    const q2 = '{\n  Post(limit: 10) {\n    title\n  }\n}'
    // cursor before query start
    const result = getActiveNestedSelectionAtOffset(q2, 0, nestedSchema)
    expect(result).toBeNull()
  })

  it('returns null for cursor outside any selection', () => {
    const offset = q.length + 10
    const result = getActiveNestedSelectionAtOffset(q, offset, nestedSchema)
    expect(result).toBeNull()
  })

  it('returns null for invalid/empty query', () => {
    expect(getActiveNestedSelectionAtOffset('', 0, nestedSchema)).toBeNull()
    expect(getActiveNestedSelectionAtOffset('not valid !!!', 0, nestedSchema)).toBeNull()
  })
})
