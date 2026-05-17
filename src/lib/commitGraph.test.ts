import { describe, it, expect } from 'vitest'
import { buildGraph, computeLayout, parseFieldDelta, displayVal } from './commitGraph'
import type { Commit } from '../hooks/useCommits'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCommit(overrides: Partial<Commit> & { cid: string; height: number; fieldName: string }): Commit {
  return {
    delta: null,
    links: [],
    signature: null,
    docID: 'bae-doc1',
    collectionVersionId: 'col-v1',
    schemaVersionId: 'schema-v1',
    ...overrides,
  }
}

function composite(cid: string, height: number, links: Commit['links'] = []): Commit {
  return makeCommit({ cid, height, fieldName: '_C', links })
}

function fieldCommit(cid: string, height: number, fieldName: string, delta: string | null = null): Commit {
  return makeCommit({ cid, height, fieldName, delta })
}

// ── buildGraph ────────────────────────────────────────────────────────────────

describe('buildGraph', () => {
  it('returns empty result for no commits', () => {
    const { nodes, allFieldNames, byCID } = buildGraph([])
    expect(nodes).toHaveLength(0)
    expect(allFieldNames).toHaveLength(0)
    expect(byCID.size).toBe(0)
  })

  it('builds a single-commit (root) graph', () => {
    const commits = [composite('c1', 1)]
    const { nodes } = buildGraph(commits)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].cid).toBe('c1')
    expect(nodes[0].isRoot).toBe(true)
    expect(nodes[0].isLatest).toBe(true)
    expect(nodes[0].isMerge).toBe(false)
    expect(nodes[0].parentCIDs).toHaveLength(0)
  })

  it('builds a linear two-commit history', () => {
    const commits = [composite('c1', 1), composite('c2', 2)]
    const { nodes } = buildGraph(commits)
    // Sorted descending: c2 first
    expect(nodes[0].cid).toBe('c2')
    expect(nodes[0].parentCIDs).toEqual(['c1'])
    expect(nodes[0].isLatest).toBe(true)
    expect(nodes[1].cid).toBe('c1')
    expect(nodes[1].parentCIDs).toHaveLength(0)
    expect(nodes[1].isRoot).toBe(true)
  })

  it('infers single parent by height when one commit exists at h-1', () => {
    const c1 = composite('c1', 1)
    const c2 = composite('c2', 2)
    const { nodes } = buildGraph([c1, c2])
    const n2 = nodes.find(n => n.cid === 'c2')!
    expect(n2.parentCIDs).toEqual(['c1'])
  })

  it('detects a merge commit (2+ parents via height inference)', () => {
    // Two concurrent writes at h=2, one merge at h=3
    const c1  = composite('c1',  1)
    const c2a = composite('c2a', 2)
    const c2b = composite('c2b', 2)
    const c3  = composite('c3',  3)
    const { nodes } = buildGraph([c1, c2a, c2b, c3])
    const merge = nodes.find(n => n.cid === 'c3')!
    expect(merge.isMerge).toBe(true)
    expect(merge.parentCIDs).toHaveLength(2)
    expect(merge.parentCIDs).toContain('c2a')
    expect(merge.parentCIDs).toContain('c2b')
  })

  it('sets parentsInferred when 2+ parents come from height inference', () => {
    const c1  = composite('c1',  1)
    const c2a = composite('c2a', 2)
    const c2b = composite('c2b', 2)
    const c3  = composite('c3',  3)
    const { nodes } = buildGraph([c1, c2a, c2b, c3])
    // c3 at h=3 infers parents from h=2 → both c2a and c2b (may include false edges)
    const n3 = nodes.find(n => n.cid === 'c3')!
    expect(n3.parentsInferred).toBe(true)
    expect(n3.parentCIDs).toContain('c2a')
    expect(n3.parentCIDs).toContain('c2b')
  })

  it('does not set parentsInferred for single-parent inference (exact)', () => {
    const c1 = composite('c1', 1)
    const c2 = composite('c2', 2)
    const { nodes } = buildGraph([c1, c2])
    const n2 = nodes.find(n => n.cid === 'c2')!
    expect(n2.parentsInferred).toBe(false)
  })

  it('collects changed field names', () => {
    const fc = fieldCommit('fc1', 2, 'name', '{"name":"Alice"}')
    const c1 = composite('c1', 1)
    const c2 = composite('c2', 2, [{ cid: 'fc1', fieldName: 'name', height: 2 }])
    const { nodes, allFieldNames } = buildGraph([c1, c2, fc])
    expect(allFieldNames).toContain('name')
    const n2 = nodes.find(n => n.cid === 'c2')!
    expect(n2.changedFields).toHaveLength(1)
    expect(n2.changedFields[0].fieldName).toBe('name')
  })

  it('marks latest node correctly', () => {
    const commits = [
      composite('c1', 1),
      composite('c2', 2),
      composite('c3', 3),
    ]
    const { nodes } = buildGraph(commits)
    const latest = nodes.filter(n => n.isLatest)
    expect(latest).toHaveLength(1)
    expect(latest[0].cid).toBe('c3')
  })

  it('handles multiple latest nodes (unmerged concurrent heads)', () => {
    const c1  = composite('c1',  1)
    const c2a = composite('c2a', 2)
    const c2b = composite('c2b', 2)
    const { nodes } = buildGraph([c1, c2a, c2b])
    const latest = nodes.filter(n => n.isLatest)
    expect(latest).toHaveLength(2)
  })
})

// ── computeLayout ─────────────────────────────────────────────────────────────

function n(cid: string, parentCIDs: string[] = []): import('./commitGraph').CompositeNode {
  return {
    cid,
    height: 1,
    parentCIDs,
    changedFields: [],
    isLatest: false,
    isRoot: parentCIDs.length === 0,
    isMerge: parentCIDs.length > 1,
    identity: null,
  }
}

describe('computeLayout', () => {
  it('returns empty for no nodes', () => {
    expect(computeLayout([])).toHaveLength(0)
  })

  it('single node gets lane 0', () => {
    const rows = computeLayout([n('a')])
    expect(rows[0].lane).toBe(0)
    expect(rows[0].convergeTo).toBeNull()
    expect(rows[0].newLanes).toHaveLength(0)
  })

  it('linear chain stays in lane 0', () => {
    const rows = computeLayout([n('c', ['b']), n('b', ['a']), n('a')])
    expect(rows.every(r => r.lane === 0)).toBe(true)
  })

  it('fork opens a new lane', () => {
    // b and c are both children of a (two branches at same height, processed newest-first)
    // In descending layout: b and c appear before a
    const rows = computeLayout([n('b', ['a']), n('c', ['a']), n('a')])
    const lanes = rows.map(r => r.lane)
    // b gets lane 0, c gets lane 1 (new lane)
    expect(lanes[0]).toBe(0)
    expect(lanes[1]).toBe(1)
  })

  it('merge commit converges lanes', () => {
    // d merges b and c; b and c both descend from a
    const rows = computeLayout([
      n('d', ['b', 'c']),
      n('b', ['a']),
      n('c', ['a']),
      n('a'),
    ])
    // d should be in lane 0
    expect(rows[0].lane).toBe(0)
    // d introduces lane for c
    expect(rows[0].newLanes).toContain(1)
    // b stays in lane 0, c stays in lane 1
    expect(rows[1].lane).toBe(0)
    expect(rows[2].lane).toBe(1)
  })

  it('root node has convergeTo null and no newLanes', () => {
    const rows = computeLayout([n('b', ['a']), n('a')])
    const root = rows[rows.length - 1]
    expect(root.convergeTo).toBeNull()
    expect(root.newLanes).toHaveLength(0)
  })
})

// ── parseFieldDelta ───────────────────────────────────────────────────────────

describe('parseFieldDelta', () => {
  it('returns — for null delta', () => {
    expect(parseFieldDelta(null, 'name')).toBe('—')
  })

  it('extracts value by fieldName', () => {
    expect(parseFieldDelta('{"name":"Alice"}', 'name')).toBe('Alice')
  })

  it('falls back to first key when fieldName not found', () => {
    expect(parseFieldDelta('{"other":"Bob"}', 'name')).toBe('Bob')
  })

  it('returns "null" string for null value', () => {
    expect(parseFieldDelta('{"name":null}', 'name')).toBe('null')
  })

  it('JSON-stringifies non-string values', () => {
    expect(parseFieldDelta('{"age":42}', 'age')).toBe('42')
    expect(parseFieldDelta('{"active":true}', 'active')).toBe('true')
  })

  it('returns raw delta when JSON parse fails', () => {
    expect(parseFieldDelta('not-json', 'name')).toBe('not-json')
  })

  it('handles array values', () => {
    expect(parseFieldDelta('{"tags":["a","b"]}', 'tags')).toBe('["a","b"]')
  })
})

// ── displayVal ────────────────────────────────────────────────────────────────

describe('displayVal', () => {
  it('passes through — and null unchanged', () => {
    expect(displayVal('—')).toBe('—')
    expect(displayVal('null')).toBe('null')
  })

  it('formats arrays as "[N items]"', () => {
    expect(displayVal('["a","b","c"]')).toBe('[3 items]')
    expect(displayVal('["only"]')).toBe('[1 item]')
    expect(displayVal('[]')).toBe('[0 items]')
  })

  it('formats relation refs as "→ docID…"', () => {
    const val = JSON.stringify({ _docID: 'bae-abc123def456ghi' })
    expect(displayVal(val)).toMatch(/^→ bae-abc123def456/)
  })

  it('formats unknown objects as "{object}"', () => {
    expect(displayVal('{"foo":"bar"}')).toBe('{object}')
  })

  it('truncates long strings', () => {
    // Use non-base64 chars to avoid the binary branch
    const long = 'héllo wörld! '.repeat(10) // 130 chars, contains non-base64
    const result = displayVal(long)
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(121)
  })

  it('formats base64 binary as [binary ~N KB]', () => {
    // 1 KB base64 ≈ 1365 chars
    const b64 = 'A'.repeat(1365)
    const result = displayVal(b64)
    expect(result).toMatch(/^\[binary ~1 KB\]/)
  })

  it('returns short plain strings unchanged', () => {
    expect(displayVal('hello')).toBe('hello')
  })

  it('returns non-JSON brace strings unchanged when short', () => {
    expect(displayVal('{not valid json')).toBe('{not valid json')
  })
})
