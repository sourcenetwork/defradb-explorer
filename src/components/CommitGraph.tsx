import { useMemo, useState, useEffect, useRef } from 'react'
import { Copy, Check, ArrowUpDown, ExternalLink, ArrowDown } from 'lucide-react'
import { useDocumentCommits, useNodeIdentity } from '../hooks/useCommits'
import type { Commit } from '../hooks/useCommits'
import styles from './CommitGraph.module.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const ROW_H   = 38
const LANE_W  = 20
const PAD_L   = 12
const PAD_R   = 8

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortCID(cid: string) { return `${cid.slice(0, 7)}…${cid.slice(-4)}` }

function commitQuery(cid: string) {
  return `{\n  _commits(cid: "${cid}") {\n    cid\n    height\n    fieldName\n    delta\n    links {\n      cid\n      fieldName\n      height\n    }\n  }\n}`
}

function fieldAtVersionQuery(collection: string, compositeCID: string, fieldName: string) {
  return `{\n  ${collection}(cid: ${JSON.stringify([compositeCID])}) {\n    _docID\n    ${fieldName}\n  }\n}`
}

// ── Data model ────────────────────────────────────────────────────────────────

interface CompositeNode {
  cid:           string
  height:        number
  parentCIDs:    string[]
  changedFields: { fieldName: string; commit: Commit }[]
  isLatest:      boolean
  isRoot:        boolean
  isMerge:       boolean   // has 2+ parents
  identity:      string | null
}

function buildGraph(commits: Commit[]) {
  if (!commits.length) return { nodes: [], allFieldNames: [], byCID: new Map<string, Commit>() }

  const byCID = new Map(commits.map(c => [c.cid, c]))

  const allFieldNames = [
    ...new Set(commits.filter(c => c.fieldName && c.fieldName !== '_C').map(c => c.fieldName!)),
  ].sort()

  const composites = commits.filter(c => c.fieldName === '_C')
  composites.sort((a, b) => b.height - a.height || a.cid.localeCompare(b.cid))

  const maxHeight = composites.length > 0 ? composites[0].height : 0

  // Index composites by height so we can infer parent relationships.
  // DefraDB's _commits links field only returns field-commit links, not the
  // parent composite link, so we derive ancestry from height ordering:
  //   parent(h) = all composites at h-1
  // This is exact for linear histories and correctly identifies forks/merges:
  //   • two composites at height H  → concurrent writes (shared parent at H-1)
  //   • one composite at height H+1 after two at H → merge commit (2 parents)
  const byHeight = new Map<number, Commit[]>()
  for (const c of composites) {
    const arr = byHeight.get(c.height) ?? []
    arr.push(c)
    byHeight.set(c.height, arr)
  }

  const nodes: CompositeNode[] = composites.map(c => {
    const parentCIDs = c.height === 1
      ? []
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

// ── Lane layout ───────────────────────────────────────────────────────────────
//
// Classic git-graph lane algorithm:
//   activeLanes[k] = CID of the commit "expected" in lane k as we scan downward.
//   For each commit (newest → oldest):
//     1. Find or assign its lane.
//     2. Replace that slot with first parent (lane continues).
//        If first parent is already in another lane, record convergence and free this lane.
//     3. Each additional parent opens a new lane (fork).
//
interface LayoutRow {
  node:         CompositeNode
  lane:         number
  lanesAfter:   (string | null)[]   // lane state after this row
  convergeTo:   number | null        // this lane closes and points toward convergeTo
  newLanes:     number[]             // lane indices that opened at this row (forks)
}

function computeLayout(nodes: CompositeNode[]): LayoutRow[] {
  const active: (string | null)[] = []
  const rows: LayoutRow[] = []

  for (const node of nodes) {
    // Find or assign this node's lane
    let myLane = active.indexOf(node.cid)
    if (myLane === -1) {
      myLane = active.indexOf(null)
      if (myLane === -1) { myLane = active.length; active.push(null) }
    }

    let convergeTo: number | null = null
    const newLanes: number[] = []

    if (node.parentCIDs.length === 0) {
      // Root — free this lane
      active[myLane] = null
    } else {
      const firstParentLane = active.indexOf(node.parentCIDs[0])
      if (firstParentLane !== -1 && firstParentLane !== myLane) {
        // First parent already tracked elsewhere → this lane converges to it
        active[myLane] = null
        convergeTo = firstParentLane
      } else {
        active[myLane] = node.parentCIDs[0]
      }

      // Additional parents (merge commit) → open new lanes
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

    // Trim trailing nulls
    while (active.length > 0 && active[active.length - 1] === null) active.pop()

    rows.push({ node, lane: myLane, lanesAfter: [...active], convergeTo, newLanes })
  }

  return rows
}

// Ascending variant: processes nodes oldest→newest, tracks children instead of parents.
function computeAscendingLayout(nodes: CompositeNode[]): LayoutRow[] {
  // Build children map
  const childrenOf = new Map<string, string[]>()
  for (const node of nodes) {
    for (const parentCID of node.parentCIDs) {
      if (!childrenOf.has(parentCID)) childrenOf.set(parentCID, [])
      childrenOf.get(parentCID)!.push(node.cid)
    }
  }

  const ascending = [...nodes].reverse()
  const active: (string | null)[] = []
  const rows: LayoutRow[] = []

  for (const node of ascending) {
    let myLane = active.indexOf(node.cid)
    if (myLane === -1) {
      myLane = active.indexOf(null)
      if (myLane === -1) { myLane = active.length; active.push(null) }
    }

    const children = childrenOf.get(node.cid) ?? []
    let convergeTo: number | null = null
    const newLanes: number[] = []

    if (children.length === 0) {
      active[myLane] = null
    } else {
      const firstChildLane = active.indexOf(children[0])
      if (firstChildLane !== -1 && firstChildLane !== myLane) {
        active[myLane] = null
        convergeTo = firstChildLane
      } else {
        active[myLane] = children[0]
      }

      for (let i = 1; i < children.length; i++) {
        if (active.indexOf(children[i]) === -1) {
          const free = active.indexOf(null)
          const idx  = free !== -1 ? free : active.length
          if (idx === active.length) active.push(children[i])
          else active[idx] = children[i]
          newLanes.push(idx)
        }
      }
    }

    while (active.length > 0 && active[active.length - 1] === null) active.pop()
    rows.push({ node, lane: myLane, lanesAfter: [...active], convergeTo, newLanes })
  }

  return rows
}

// ── SVG graph component ───────────────────────────────────────────────────────

const LANE_COLORS = ['#10CBFF', '#c792ea', '#39e265', '#ffcb6b', '#ff9f43', '#fd79a8', '#74b9ff', '#55efc4']
const DOT_R = 2.5

function GraphSVG({ rows, visStart, visEnd, highlightEdge }: {
  rows: LayoutRow[]
  visStart: number
  visEnd: number
  highlightEdge?: { from: string; to: string } | null
}) {
  if (!rows.length) return null

  const maxLanes = rows.reduce((m, r) => {
    const max = Math.max(r.lane + 1, ...r.newLanes.map(l => l + 1), r.lanesAfter.filter(Boolean).length)
    return Math.max(m, max)
  }, 1)

  const svgW = PAD_L + maxLanes * LANE_W + PAD_R
  const svgH = rows.length * ROW_H

  const lx = (lane: number) => PAD_L + lane * LANE_W + LANE_W / 2
  const ry = (i: number)    => i * ROW_H + ROW_H / 2
  const lc = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]

  const rowIndex = new Map<string, number>()
  rows.forEach((r, i) => rowIndex.set(r.node.cid, i))

  const edges:     React.ReactNode[] = []
  const hotEdges:  React.ReactNode[] = []  // highlighted edges rendered on top
  const dots:      React.ReactNode[] = []

  for (let i = visStart; i < visEnd; i++) {
    const row   = rows[i]
    const x1    = lx(row.lane)
    const y1    = ry(i)
    const color = lc(row.lane)

    const isDimmed = !!highlightEdge && row.node.cid !== highlightEdge.from && row.node.cid !== highlightEdge.to

    row.node.parentCIDs.forEach((parentCID, pi) => {
      const pIdx = rowIndex.get(parentCID)
      if (pIdx === undefined) {
        edges.push(
          <line key={`edge-${i}-stub-${pi}`}
            x1={x1} y1={y1 + DOT_R}
            x2={x1} y2={Math.min(y1 + ROW_H * 1.5, svgH)}
            stroke={color} strokeWidth={1.5} opacity={highlightEdge ? 0.2 : 0.25} strokeDasharray="3,3" />
        )
        return
      }

      const isHot  = highlightEdge?.from === row.node.cid && highlightEdge?.to === parentCID
      const dimEdge = !!highlightEdge && !isHot
      const pRow   = rows[pIdx]
      const x2     = lx(pRow.lane)
      const y2     = ry(pIdx)
      const dist   = y2 - y1
      const T      = Math.max(dist * 0.5, Math.abs(x2 - x1) * 0.6, 14)
      const target = isHot ? hotEdges : edges

      if (Math.abs(x1 - x2) < 0.5) {
        target.push(
          <line key={`edge-${i}-${pIdx}`}
            x1={x1} y1={y1 + DOT_R} x2={x2} y2={y2 - DOT_R}
            stroke={color} strokeWidth={isHot ? 2.5 : 1.5} opacity={isHot ? 1 : dimEdge ? 0.28 : 0.45} />
        )
      } else {
        target.push(
          <path key={`edge-${i}-${pIdx}`}
            d={`M ${x1},${y1 + DOT_R} C ${x1},${y1 + T} ${x2},${y2 - T} ${x2},${y2 - DOT_R}`}
            fill="none" stroke={color} strokeWidth={isHot ? 2.5 : 1.5} opacity={isHot ? 1 : dimEdge ? 0.28 : 0.45} />
        )
      }
    })

    const isHotNode = !!highlightEdge && (row.node.cid === highlightEdge.from || row.node.cid === highlightEdge.to)

    if (row.node.isMerge) {
      const r = 4
      dots.push(
        <polygon key={`dot-${i}`}
          points={`${x1},${y1 - r} ${x1 + r},${y1} ${x1},${y1 + r} ${x1 - r},${y1}`}
          fill={row.node.isLatest || isHotNode ? color : '#131330'}
          stroke={color} strokeWidth={isHotNode ? 2 : 1.5} opacity={isDimmed ? 0.45 : 1} />
      )
    } else {
      dots.push(
        <circle key={`dot-${i}`}
          cx={x1} cy={y1}
          r={row.node.isLatest ? 3.5 : row.node.isRoot ? 2.5 : DOT_R}
          fill={row.node.isLatest || isHotNode ? color : '#0d0d20'}
          stroke={color} strokeWidth={row.node.isLatest ? 2 : 1.5} opacity={isDimmed ? 0.45 : 1} />
      )
    }
  }

  return (
    <svg width={svgW} height={svgH} className={styles.svg}>
      {edges}
      {hotEdges}
      {dots}
    </svg>
  )
}

// ── Detail sidebar ────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <button onClick={copy} title="Copy"
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
               color: copied ? '#39e265' : 'var(--gray-600)', lineHeight: 1, display: 'flex', alignItems: 'center' }}>
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  )
}

function QueryRunnerButton({ cid, onOpen }: { cid: string; onOpen?: (query: string) => void }) {
  if (!onOpen) return null
  return (
    <button
      onClick={() => onOpen(commitQuery(cid))}
      title="Open in Query Runner"
      className={styles.queryBtn}
    >
      <ExternalLink size={11} />
    </button>
  )
}

function parseFieldDelta(delta: string | null, fieldName: string): string {
  if (!delta) return '—'
  try {
    const parsed = JSON.parse(delta)
    const val = parsed[fieldName] ?? parsed[Object.keys(parsed)[0]]
    if (val === null || val === undefined) return 'null'
    return typeof val === 'string' ? val : JSON.stringify(val)
  } catch { return delta }
}

// Display-only formatting — parseFieldDelta returns raw values used for equality
// checks; displayVal formats them for rendering without affecting comparisons.
function displayVal(raw: string): string {
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

function findPrevFieldCommit(fieldName: string, currentHeight: number, byCID: Map<string, Commit>): Commit | undefined {
  // Find the most recent field commit for this field before the current height.
  // This is more reliable than traversing links, which may not be populated for merge commits.
  let best: Commit | undefined
  for (const c of byCID.values()) {
    if (c.fieldName === fieldName && c.height < currentHeight) {
      if (!best || c.height > best.height) best = c
    }
  }
  return best
}

function ChangeDiff({ node, byCID, hoveredParentCID, onOpenInQueryRunner, collection }: {
  node: CompositeNode
  byCID: Map<string, Commit>
  hoveredParentCID?: string | null
  onOpenInQueryRunner?: (query: string) => void
  collection?: string
}) {
  if (!node.changedFields.length) return null

  // Build a field→value map for the hovered parent's state
  const parentFieldValues = useMemo(() => {
    if (!hoveredParentCID) return null
    const parentComposite = byCID.get(hoveredParentCID)
    if (!parentComposite) return null
    const map = new Map<string, string | null>()
    for (const link of parentComposite.links) {
      if (link.fieldName && link.fieldName !== '_C') {
        const fieldCommit = byCID.get(link.cid)
        if (fieldCommit) map.set(link.fieldName, parseFieldDelta(fieldCommit.delta, link.fieldName))
      }
    }
    return map
  }, [hoveredParentCID, byCID])

  // For non-merge commits, find the previous version number for the label
  const prevHeight = useMemo(() => {
    if (node.isMerge || hoveredParentCID) return null
    for (const { fieldName } of node.changedFields) {
      const prev = findPrevFieldCommit(fieldName, node.height, byCID)
      if (prev) return prev.height
    }
    return null
  }, [node, byCID, hoveredParentCID])

  const label = hoveredParentCID
    ? `changes vs ${hoveredParentCID.slice(0, 7)}…${hoveredParentCID.slice(-4)}`
    : prevHeight !== null
      ? `changes from v${prevHeight}`
      : 'changes'

  // Merge commit with no parent selected — prompt user to select a parent
  if (node.isMerge && !hoveredParentCID) {
    return (
      <div className={styles.sidebarSection}>
        <div className={styles.sidebarLabel}>changes</div>
        <span className={styles.sidebarEmpty}>select a parent to compare</span>
      </div>
    )
  }

  return (
    <div className={styles.sidebarSection}>
      <div className={styles.sidebarLabel}>{label}</div>
      <div className={styles.diffList}>
        {node.changedFields.map(({ fieldName, commit }) => {
          const newVal = parseFieldDelta(commit.delta, fieldName)
          const oldVal = parentFieldValues
            ? (parentFieldValues.has(fieldName) ? parentFieldValues.get(fieldName)! : null)
            : (() => {
                const prev = findPrevFieldCommit(fieldName, node.height, byCID)
                return prev ? parseFieldDelta(prev.delta, fieldName) : null
              })()

          // When comparing against a parent: did the CRDT keep this parent's value?
          const kept = parentFieldValues !== null && oldVal !== null && oldVal === newVal

          return (
            <div key={fieldName} className={styles.diffRow}>
              <div className={styles.diffFieldHeader}>
                <span className={styles.diffFieldName}>{fieldName}</span>
                {kept && <span className={styles.diffKept}>kept</span>}
                {onOpenInQueryRunner && (
                  <button
                    onClick={() => onOpenInQueryRunner(
                      collection
                        ? fieldAtVersionQuery(collection, node.cid, fieldName)
                        : commitQuery(commit.cid)
                    )}
                    title="Open in Query Runner"
                    className={styles.queryBtn}
                  >
                    <ExternalLink size={11} />
                  </button>
                )}
              </div>
              {!kept && (
                <div className={styles.diffValues}>
                  {oldVal !== null && (
                    <>
                      <span className={styles.diffOld}>{displayVal(oldVal)}</span>
                      <span className={styles.diffArrow}>→</span>
                    </>
                  )}
                  <span className={styles.diffNew}>{displayVal(newVal)}</span>
                </div>
              )}
              {kept && (
                <div className={styles.diffValues}>
                  <span className={styles.diffNew}>{displayVal(newVal)}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CommitDetailSidebar({ node, width, onResize, onClose, onOpenInQueryRunner, onHighlightParent, onSelectParent, onLockParent, byCID, lockedParentCID, collection, headCount, localIdentity }: {
  node: CompositeNode
  width: number
  onResize: (e: React.MouseEvent) => void
  onClose: () => void
  onOpenInQueryRunner?: (query: string) => void
  onHighlightParent?: (cid: string | null) => void
  onSelectParent?: (cid: string) => void
  onLockParent: (cid: string) => void
  byCID: Map<string, Commit>
  lockedParentCID: string | null
  collection?: string
  headCount?: number
  localIdentity?: string | null
}) {
  const compareParentCID = lockedParentCID

  return (
    <div className={styles.sidebar} style={{ width }}>
      <div className={styles.sidebarResizeHandle} onMouseDown={onResize} />
      <div className={styles.sidebarHeader}>
        <div className={styles.sidebarTitle}>
          <span className={styles.sidebarVersion}>v{node.height}</span>
          {node.isLatest && <span className={styles.tagLatest}>head</span>}
          {node.isMerge  && <span className={styles.tagMerge}>merge</span>}
          {node.isRoot   && <span className={styles.tagRoot}>root</span>}
          {node.isLatest && node.identity && (
            <span
              className={`${styles.tagIdentity} ${node.identity === localIdentity ? styles.tagIdentityLocal : ''}`}
              title={node.identity}
            >
              {node.identity === localIdentity ? 'you' : `${node.identity.slice(0, 6)}…`}
            </span>
          )}
        </div>
        <button className={styles.sidebarClose} onClick={onClose}>×</button>
      </div>

      <div className={styles.sidebarBody}>

        {/* Merge context note */}
        {node.isMerge && (
          <div className={styles.mergeNote}>
            Merged {node.parentCIDs.length} concurrent writes at v{node.height - 1}
          </div>
        )}

        {/* Head context note */}
        {node.isLatest && headCount != null && headCount > 1 && (
          <div className={styles.mergeNote}>
            {headCount} unmerged branch tips at this height
          </div>
        )}

        {/* Composite CID */}
        <div className={styles.sidebarSection}>
          <div className={styles.sidebarLabel}>composite cid</div>
          <div className={styles.sidebarCIDRow}>
            <span className={styles.sidebarCIDFull}>{node.cid}</span>
            <CopyButton text={node.cid} />
            <QueryRunnerButton cid={node.cid} onOpen={onOpenInQueryRunner} />
          </div>
        </div>

        {/* Parents */}
        {node.parentCIDs.length > 0 && (
          <div className={styles.sidebarSection}>
            <div className={styles.sidebarLabel}>
              {node.isMerge ? `parents (${node.parentCIDs.length})` : 'parent'}
            </div>
            <div className={styles.parentsScroll}>
              {node.parentCIDs.map(p => {
                const parentHeight = byCID.get(p)?.height
                const isLocked = p === lockedParentCID
                return (
                  <div key={p} className={styles.parentRowWrap}>
                    <div
                      className={[
                        styles.sidebarCIDRow,
                        styles.sidebarParentRow,
                        isLocked ? styles.sidebarParentRowLocked : '',
                      ].join(' ')}
                      onMouseEnter={() => onHighlightParent?.(p)}
                      onMouseLeave={() => onHighlightParent?.(null)}
                      onClick={() => onLockParent(p)}
                    >
                      {parentHeight !== undefined && (
                        <span className={styles.sidebarParentVersion}>v{parentHeight}</span>
                      )}
                      <span className={styles.sidebarParentCID}>{p}</span>
                      <CopyButton text={p} />
                      <QueryRunnerButton cid={p} onOpen={onOpenInQueryRunner} />
                    </div>
                    {onSelectParent && (
                      <button
                        className={styles.parentNavBtn}
                        title="Navigate to this commit"
                        onClick={() => onSelectParent(p)}
                      >
                        <ArrowDown size={13} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Changes diff */}
        <ChangeDiff
          node={node}
          byCID={byCID}
          hoveredParentCID={compareParentCID}
          onOpenInQueryRunner={onOpenInQueryRunner}
          collection={collection}
        />

      </div>
    </div>
  )
}

// ── Virtual-scrolled log ──────────────────────────────────────────────────────

const OVERSCAN = 8

function CommitLog({ rows, onOpenInQueryRunner, byCID, collection, localIdentity }: {
  rows: LayoutRow[]
  onOpenInQueryRunner?: (query: string) => void
  byCID: Map<string, Commit>
  collection?: string
  localIdentity?: string | null
}) {
  const displayRows = rows
  const [selected,        setSelected]      = useState<string | null>(null)
  const [highlighted,     setHighlighted]   = useState<string | null>(null)
  const [lockedParentCID, setLockedParentCID] = useState<string | null>(null)
  const [panelWidth,      setPanelWidth]    = useState<number | null>(null)
  const [sidebarWidth,    setSidebarWidth]  = useState(340)
  const selectedNode = selected ? displayRows.find(r => r.node.cid === selected)?.node ?? null : null
  const headCount = rows.filter(r => r.node.isLatest).length


  const scrollRef  = useRef<HTMLDivElement>(null)
  const svgPanelRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH,     setViewH]     = useState(600)

  // Set up scroll listener and resize observer once on mount
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewH(el.clientHeight)
    const onScroll = () => setScrollTop(el.scrollTop)
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    el.addEventListener('scroll', onScroll, { passive: true })
    ro.observe(el)
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect() }
  }, [])

  // Reset scroll to top whenever the commit list or direction changes
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    setScrollTop(0)
    setSelected(null)
    setHighlighted(null)
    setLockedParentCID(null)
    const maxL = rows.reduce((m, r) => Math.max(
      m, r.lane + 1,
      ...r.newLanes.map(l => l + 1),
      r.lanesAfter.filter(Boolean).length,
    ), 1)
    setPanelWidth(Math.min(PAD_L + maxL * LANE_W + PAD_R, 180))
  }, [rows])

  function smoothScrollBy(el: HTMLElement, delta: number, duration = 520) {
    const start    = el.scrollTop
    const end      = start + delta
    const t0       = performance.now()
    const easeOut  = (t: number) => 1 - Math.pow(1 - t, 3) // cubic ease-out
    let rafId: number
    function step(now: number) {
      const t = Math.min(1, (now - t0) / duration)
      el.scrollTop = start + (end - start) * easeOut(t)
      if (t < 1) rafId = requestAnimationFrame(step)
    }
    rafId = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafId)
  }

  function scrollToCID(cid: string) {
    const idx = displayRows.findIndex(r => r.node.cid === cid)
    if (idx === -1) return
    const top = idx * ROW_H
    const el  = scrollRef.current
    if (!el) return
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: top - el.clientHeight / 2 + ROW_H / 2, behavior: 'smooth' })
    }
  }

  // Arrow key navigation
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const idx = selected ? displayRows.findIndex(r => r.node.cid === selected) : -1
    let next: number
    if (e.key === 'ArrowDown') next = idx === -1 ? 0 : Math.min(idx + 1, displayRows.length - 1)
    else                        next = idx === -1 ? displayRows.length - 1 : Math.max(idx - 1, 0)
    const cid = displayRows[next]?.node.cid
    if (!cid) return
    setSelected(cid)
    setLockedParentCID(null)
    // Scroll row into view
    const top = next * ROW_H
    const el  = scrollRef.current
    if (el) {
      if (top < el.scrollTop) el.scrollTo({ top, behavior: 'smooth' })
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTo({ top: top + ROW_H - el.clientHeight, behavior: 'smooth' })
    }
  }

  // Drag-to-resize the SVG graph panel
  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX     = e.clientX
    const startWidth = svgPanelRef.current?.getBoundingClientRect().width ?? 80
    const onMove = (ev: MouseEvent) => {
      setPanelWidth(Math.max(40, startWidth + ev.clientX - startX))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Drag-to-resize the detail sidebar
  function startSidebarResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX     = e.clientX
    const startWidth = sidebarWidth
    const onMove = (ev: MouseEvent) => {
      setSidebarWidth(Math.max(200, startWidth - (ev.clientX - startX)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const endIdx   = Math.min(displayRows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  const padTop   = startIdx * ROW_H
  const padBot   = (displayRows.length - endIdx) * ROW_H
  const visRows  = displayRows.slice(startIdx, endIdx)

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className={styles.logBody} tabIndex={0} onKeyDown={handleKeyDown} style={{ outline: 'none' }}>
      <div ref={scrollRef} className={styles.logScroll}>
        {/* SVG graph — full virtual height, only visible elements rendered */}
        <div ref={svgPanelRef} className={styles.svgWrap}
          style={panelWidth !== null ? { width: panelWidth } : undefined}>
          <GraphSVG
            rows={displayRows}
            visStart={startIdx}
            visEnd={endIdx}
            highlightEdge={selected && (highlighted ?? lockedParentCID) ? { from: selected, to: (highlighted ?? lockedParentCID)! } : null}
          />
          <div className={styles.resizeHandle} onMouseDown={startResize} />
        </div>

        {/* Rows — padding creates virtual scroll space above/below */}
        <div className={styles.rowList} style={{ paddingTop: padTop, paddingBottom: padBot }}>
          {visRows.map((row) => {
            const { node } = row
            const isSelected = node.cid === selected
            return (
              <div key={node.cid}
                className={[
                  styles.logRow,
                  node.isLatest              ? styles.logRowLatest      : '',
                  node.isMerge               ? styles.logRowMerge       : '',
                  isSelected                 ? styles.logRowSelected    : '',
                  node.cid === highlighted   ? styles.logRowHighlighted : '',
                ].join(' ')}
                style={{ height: ROW_H }}
                onClick={() => { setSelected(s => s === node.cid ? null : node.cid); setLockedParentCID(null) }}
              >
                <div className={styles.vCol}>
                  <span className={styles.vNum}>v{node.height}</span>
                  {node.isLatest && <span className={styles.tagLatest}>head</span>}
                  {node.isRoot   && <span className={styles.tagRoot}>root</span>}
                  {node.isMerge  && <span className={styles.mergeDot} title="merge commit" />}
                </div>

                <div className={styles.cidCol}>
                  <span className={styles.compCid} title={node.cid}>{shortCID(node.cid)}</span>
                </div>

                <div className={styles.changedCol}>
                  {node.changedFields.length === 0 ? (
                    <span className={styles.noChange}>—</span>
                  ) : (() => {
                    const MAX = 3
                    const shown = node.changedFields.slice(0, MAX)
                    const extra = node.changedFields.length - MAX
                    return <>
                      {shown.map(({ fieldName }) => (
                        <span key={fieldName} className={styles.fieldTag}>{fieldName}</span>
                      ))}
                      {extra > 0 && (
                        <span className={styles.fieldExtra}
                          title={node.changedFields.slice(MAX).map(f => f.fieldName).join(', ')}>
                          +{extra}
                        </span>
                      )}
                    </>
                  })()}
                  {node.isLatest && node.identity && (
                    <span
                      className={`${styles.tagIdentity} ${node.identity === localIdentity ? styles.tagIdentityLocal : ''}`}
                      style={{ marginLeft: 'auto' }}
                      title={node.identity}
                    >
                      {node.identity === localIdentity ? 'you' : `${node.identity.slice(0, 6)}…`}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {selectedNode && (
        <CommitDetailSidebar
          key={selectedNode.cid}
          node={selectedNode}
          width={sidebarWidth}
          onResize={startSidebarResize}
          onClose={() => setSelected(null)}
          onOpenInQueryRunner={onOpenInQueryRunner}
          onHighlightParent={cid => { setHighlighted(cid); if (cid) scrollToCID(cid) }}
          onSelectParent={cid => {
            const fromIdx = selected ? displayRows.findIndex(r => r.node.cid === selected) : -1
            const toIdx   = displayRows.findIndex(r => r.node.cid === cid)
            if (fromIdx !== -1 && toIdx !== -1 && scrollRef.current) {
              smoothScrollBy(scrollRef.current, (toIdx - fromIdx) * ROW_H)
            } else {
              scrollToCID(cid)
            }
            setSelected(cid)
            setHighlighted(null)
            setLockedParentCID(null)
          }}
          onLockParent={cid => { setLockedParentCID(cid); scrollToCID(cid) }}
          byCID={byCID}
          lockedParentCID={lockedParentCID ?? selectedNode.parentCIDs[0] ?? null}
          collection={collection}
          headCount={headCount}
          localIdentity={localIdentity}
        />
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CommitGraph({ docID, onOpenInQueryRunner, onOpenInCollections, collection }: {
  docID: string
  onOpenInQueryRunner?: (query: string) => void
  onOpenInCollections?: (collection: string, docID: string) => void
  collection?: string
}) {
  const [reversed, setReversed] = useState(false)
  const { data: commits = [], isLoading, isError } = useDocumentCommits(docID)
  const { data: localIdentity } = useNodeIdentity()

  const { nodes, allFieldNames, byCID } = useMemo(() => buildGraph(commits), [commits])
  const descRows = useMemo(() => computeLayout(nodes), [nodes])
  const ascRows  = useMemo(() => computeAscendingLayout(nodes), [nodes])
  const rows = reversed ? ascRows : descRows

  if (isLoading) return (
    <div className={styles.loading}><div className={styles.spin} />Loading commits…</div>
  )
  if (isError)        return <div className={styles.empty}>Could not load commit graph.</div>
  if (!commits.length) return <div className={styles.empty}>No commits for this document.</div>

  const mergeCount = nodes.filter(n => n.isMerge).length

  return (
    <div className={styles.wrapper}>
      <div className={styles.infoBar}>
        <span className={styles.infoItem}>{nodes.length} commits</span>
        <span className={styles.infoDot}>·</span>
        <span className={styles.infoItem}>{allFieldNames.length} fields</span>
        {mergeCount > 0 && <>
          <span className={styles.infoDot}>·</span>
          <span className={styles.infoMerge}>{mergeCount} merge{mergeCount > 1 ? 's' : ''}</span>
        </>}
        <span className={styles.infoDot}>·</span>
        <span className={styles.infoDocID}>{docID}</span>
        {collection && onOpenInQueryRunner && (
          <button
            className={styles.infoBtn}
            onClick={() => onOpenInQueryRunner(`{\n  ${collection}(docID: ${JSON.stringify(docID)}) {\n    _docID\n  }\n}`)}
            title="Open document in Query Runner"
          >
            Query Runner
          </button>
        )}
        {collection && onOpenInCollections && (
          <button
            className={styles.infoBtn}
            onClick={() => onOpenInCollections(collection, docID)}
            title="Open document in Collections"
          >
            Collections
          </button>
        )}
        <button
          className={styles.flipBtn}
          onClick={() => setReversed(r => !r)}
          title={reversed ? 'Ascending — v1 at top' : 'Descending — highest version at top'}
        >
          <ArrowUpDown size={12} />
        </button>
      </div>

      <div className={styles.logWrap}>
        <CommitLog
          rows={rows}
          onOpenInQueryRunner={onOpenInQueryRunner}
          byCID={byCID}
          collection={collection}
          localIdentity={localIdentity ?? null}
        />
      </div>
    </div>
  )
}
