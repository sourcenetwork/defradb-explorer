import type { Commit } from '../hooks/useCommits'

// ── Data model ─────────────────────────────────────────────────────────────────

export interface CompositeNode {
  cid:           string
  height:        number
  parentCIDs:    string[]
  changedFields: { fieldName: string; commit: Commit }[]
  isLatest:      boolean
  isRoot:        boolean
  isMerge:       boolean
  identity:      string | null
}

export interface LayoutRow {
  node:       CompositeNode
  lane:       number
  lanesAfter: (string | null)[]
  convergeTo: number | null
  newLanes:   number[]
}

// ── Graph builder ──────────────────────────────────────────────────────────────

export function buildGraph(commits: Commit[]) {
  if (!commits.length) return { nodes: [], allFieldNames: [], byCID: new Map<string, Commit>() }

  const byCID = new Map(commits.map(c => [c.cid, c]))

  const allFieldNames = [
    ...new Set(commits.filter(c => c.fieldName && c.fieldName !== '_C').map(c => c.fieldName!)),
  ].sort()

  const composites = commits.filter(c => c.fieldName === '_C')
  composites.sort((a, b) => b.height - a.height || a.cid.localeCompare(b.cid))

  const maxHeight = composites.length > 0 ? composites[0].height : 0

  const byHeight = new Map<number, Commit[]>()
  for (const c of composites) {
    const arr = byHeight.get(c.height) ?? []
    arr.push(c)
    byHeight.set(c.height, arr)
  }

  const nodes: CompositeNode[] = composites.map(c => {
    // Prefer actual parent composite links (fieldName === '_C') when the API returns them.
    // Fall back to height-based inference only when none are present — the height
    // approach creates false edges for histories with diverged branches at the same height.
    const actualParentCIDs = c.links
      .filter(l => l.fieldName === '_C' && byCID.has(l.cid))
      .map(l => l.cid)
    const parentCIDs = c.height === 1
      ? []
      : actualParentCIDs.length > 0
        ? actualParentCIDs
        : (byHeight.get(c.height - 1) ?? []).map(p => p.cid)

    const changedFields = c.links
      .filter(l => l.fieldName && l.fieldName !== '_C' && byCID.has(l.cid))
      .map(l => ({ fieldName: l.fieldName!, commit: byCID.get(l.cid)! }))

    return {
      cid:          c.cid,
      height:       c.height,
      parentCIDs,
      changedFields,
      isLatest:     c.height === maxHeight,
      isRoot:       c.height === 1,
      isMerge:      parentCIDs.length > 1,
      identity:     c.signature?.identity ?? null,
    }
  })

  return { nodes, allFieldNames, byCID }
}

// ── Lane layout ────────────────────────────────────────────────────────────────
//
// Classic git-graph lane algorithm (descending: newest → oldest):
//   activeLanes[k] = CID of the commit "expected" in lane k.
//   For each commit:
//     1. Find or assign its lane.
//     2. Replace that slot with first parent (lane continues).
//        If first parent already tracked elsewhere → this lane converges there.
//     3. Each additional parent opens a new lane (fork).

export function computeLayout(nodes: CompositeNode[]): LayoutRow[] {
  const active: (string | null)[] = []
  const rows: LayoutRow[] = []

  for (const node of nodes) {
    let myLane = active.indexOf(node.cid)
    if (myLane === -1) {
      myLane = active.indexOf(null)
      if (myLane === -1) { myLane = active.length; active.push(null) }
    }

    let convergeTo: number | null = null
    const newLanes: number[] = []

    if (node.parentCIDs.length === 0) {
      active[myLane] = null
    } else {
      const firstParentLane = active.indexOf(node.parentCIDs[0])
      if (firstParentLane !== -1 && firstParentLane !== myLane) {
        active[myLane] = null
        convergeTo = firstParentLane
      } else {
        active[myLane] = node.parentCIDs[0]
      }

      for (let i = 1; i < node.parentCIDs.length; i++) {
        if (active.indexOf(node.parentCIDs[i]) === -1) {
          const free = active.indexOf(null)
          const idx  = free !== -1 ? free : active.length
          if (idx === active.length) active.push(node.parentCIDs[i])
          else active[idx] = node.parentCIDs[i]
          newLanes.push(idx)
        }
      }
    }

    while (active.length > 0 && active[active.length - 1] === null) active.pop()
    rows.push({ node, lane: myLane, lanesAfter: [...active], convergeTo, newLanes })
  }

  return rows
}

// ── Field delta parsing ────────────────────────────────────────────────────────

export function parseFieldDelta(delta: string | null, fieldName: string): string {
  if (!delta) return '—'
  try {
    const parsed = JSON.parse(delta)
    const val = parsed[fieldName] ?? parsed[Object.keys(parsed)[0]]
    if (val === null || val === undefined) return 'null'
    return typeof val === 'string' ? val : JSON.stringify(val)
  } catch { return delta }
}

export function displayVal(raw: string): string {
  if (raw === '—' || raw === 'null') return raw
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return `[${parsed.length} item${parsed.length !== 1 ? 's' : ''}]`
      if (parsed._docID) return `→ ${String(parsed._docID).slice(0, 16)}…`
      return '{object}'
    } catch { /* not valid JSON, fall through */ }
  }
  if (raw.length > 120) {
    if (/^[A-Za-z0-9+/]+=*$/.test(raw))
      return `[binary ~${Math.round(raw.length * 0.75 / 1024)} KB]`
    return raw.slice(0, 120) + '…'
  }
  return raw
}
