import { useState, useRef, useEffect, useMemo } from 'react'
import { Copy, Check, ArrowLeft, X, ArrowUpDown, ExternalLink, Play } from 'lucide-react'
import { useRecentCommitsPage, useDocumentCommits, useCommitByCID, RAW_PAGE_SIZE } from '../hooks/useCommits'
import type { Commit } from '../hooks/useCommits'
import { useCollections } from '../hooks/useCollections'
import { useIntrospection } from '../hooks/useIntrospection'
import { useDocumentById } from '../hooks/useDocuments'
import { isScalarField } from '../api/graphql'
import { useUIStore } from '../store/uiStore'
import styles from './CommitsView.module.css'

import CommitGraph from '../components/CommitGraph'

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortCID(cid: string) {
  return cid.length > 20 ? `${cid.slice(0, 10)}…${cid.slice(-6)}` : cid
}


function CopyButton({ text, onClick }: { text: string; onClick?: (e: React.MouseEvent) => void }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ''}`} onClick={e => { onClick?.(e); copy() }} title={text}>
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  )
}


function FieldChip({ name }: { name: string | null }) {
  const isComposite = name === '_C' || name == null
  return (
    <span className={`${styles.fieldChip} ${isComposite ? styles.fieldChipComposite : ''}`}>
      {isComposite ? 'composite' : name}
    </span>
  )
}

function HeightBadge({ height }: { height: number }) {
  return <span className={styles.heightBadge}>v{height}</span>
}

function Skeleton() {
  return (
    <div className={styles.skeletons}>
      {[80, 60, 75, 55, 70].map((w, i) => (
        <div key={i} className={styles.skeletonRow}>
          <div className={styles.skeletonCell} style={{ width: 28 }} />
          <div className={styles.skeletonCell} style={{ width: 70 }} />
          <div className={styles.skeletonCell} style={{ width: `${w}px` }} />
          <div className={styles.skeletonCell} style={{ flex: 1 }} />
        </div>
      ))}
    </div>
  )
}

// ── Flat commit row ───────────────────────────────────────────────────────────

function CommitRow({ commit, onSelectDoc, collection }: {
  commit: Commit
  onSelectDoc: (id: string) => void
  collection: string | null
}) {
  const changedFields = commit.links
    .filter(l => l.fieldName && l.fieldName !== '_C')
    .map(l => l.fieldName!)
  return (
    <div className={styles.recentRow} onClick={() => onSelectDoc(commit.docID)} role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onSelectDoc(commit.docID)}>
      <HeightBadge height={commit.height} />
      <span className={styles.recentDocID} title={commit.docID}>{commit.docID}</span>
      {collection
        ? <span className={styles.collectionChip}>{collection}</span>
        : <span />
      }
      <div className={styles.fieldList}>
        {changedFields.map(f => <FieldChip key={f} name={f} />)}
        {changedFields.length === 0 && <span className={styles.compositeLabel}>no field changes</span>}
      </div>
      <div className={styles.cidCell}>
        <span className={styles.cid} title={commit.cid}>{shortCID(commit.cid)}</span>
        <CopyButton text={commit.cid} onClick={e => e.stopPropagation()} />
      </div>
    </div>
  )
}

// Fetches one raw page and reports composites + hasMore to parent
function CommitPage({ pageIndex, onData }: {
  pageIndex: number
  onData: (index: number, commits: Commit[], hasMore: boolean) => void
}) {
  const { data, isLoading, isError } = useRecentCommitsPage(pageIndex * RAW_PAGE_SIZE)
  useEffect(() => {
    if (data) onData(pageIndex, data.composites, data.hasMore)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])
  if (isLoading && pageIndex === 0) return <Skeleton />
  if (isError   && pageIndex === 0) return <p className={styles.empty}>Failed to load commits.</p>
  return null
}

function RecentFeed({ onSelectDoc }: { onSelectDoc: (id: string) => void }) {
  const [pages, setPages]           = useState(1)
  const [allCommits, setAllCommits] = useState<Commit[]>([])
  const [hasMore, setHasMore]       = useState(false)
  const [sortByHeight, setSortByHeight] = useState(false)
  const pageDataRef = useRef<Map<number, Commit[]>>(new Map())
  const { data: collections = [] } = useCollections()
  const versionToCollection = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of collections) m.set(c.version_id, c.name)
    return m
  }, [collections])

  function handlePageData(pageIndex: number, commits: Commit[], more: boolean) {
    pageDataRef.current.set(pageIndex, commits)
    const accumulated: Commit[] = []
    for (let i = 0; i < pages; i++) {
      accumulated.push(...(pageDataRef.current.get(i) ?? []))
    }
    setAllCommits(accumulated)
    if (pageIndex === pages - 1) setHasMore(more)
  }

  const displayed = sortByHeight
    ? [...allCommits].sort((a, b) => b.height - a.height)
    : allCommits
  const loading = allCommits.length === 0

  return (
    <div className={styles.feedWrap}>
      {Array.from({ length: pages }, (_, i) => (
        <CommitPage key={i} pageIndex={i} onData={handlePageData} />
      ))}

      {!loading && (
        <>
          <div className={styles.feedHeader}>
            <span className={styles.feedCount}>{allCommits.length}{hasMore ? '+' : ''} commit{allCommits.length !== 1 ? 's' : ''}{hasMore ? ' loaded' : ''}</span>
            <button
              className={`${styles.sortBtn} ${sortByHeight ? styles.sortBtnActive : ''}`}
              onClick={() => setSortByHeight(v => !v)}
              title={sortByHeight ? 'Sorted by height — click to restore default order' : 'Sort by height'}
            >
              <ArrowUpDown size={11} />
              {sortByHeight ? 'By height' : 'Default order'}
            </button>
          </div>
          {allCommits.length === 0
            ? <p className={styles.empty}>No commits found.</p>
            : <div className={styles.commitList}>
                {displayed.map(commit => (
                  <CommitRow
                    key={commit.cid}
                    commit={commit}
                    onSelectDoc={onSelectDoc}
                    collection={commit.collectionVersionId ? versionToCollection.get(commit.collectionVersionId) ?? null : null}
                  />
                ))}
              </div>
          }
          {hasMore && (
            <button className={styles.loadMore} onClick={() => setPages(p => p + 1)}>
              Load more
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Document info card ────────────────────────────────────────────────────────

const AGGREGATE_FIELDS = new Set(['AVG', 'COUNT', 'MAX', 'MIN', 'SUM', 'SIMILARITY'])

function DocInfoCard({ docID, onOpenInCollections, onOpenInQueryRunner, showFields = true }: {
  docID: string
  onOpenInCollections?: (collection: string, docID: string) => void
  onOpenInQueryRunner?: (query: string) => void
  showFields?: boolean
}) {
  const { data: commits = [] }      = useDocumentCommits(docID)
  const { data: collections = [] }  = useCollections()
  const { data: schema }            = useIntrospection()

  const collectionVersionId = commits[0]?.collectionVersionId ?? null

  const collectionName = useMemo(() => {
    if (!collectionVersionId) return null
    return collections.find(c => c.version_id === collectionVersionId)?.name ?? null
  }, [collectionVersionId, collections])

  const scalarFields = useMemo(() => {
    if (!schema || !collectionName) return []
    const type = schema.__schema.types.find(t => t.name === collectionName)
    if (!type?.fields) return ['_docID']
    return type.fields
      .filter(f => isScalarField(f.type) && !AGGREGATE_FIELDS.has(f.name) && (f.name === '_docID' || !f.name.startsWith('_')))
      .map(f => f.name)
  }, [schema, collectionName])

  const { data: doc } = useDocumentById(collectionName ?? '', docID, scalarFields)

  if (!collectionName) return null

  const displayFields = scalarFields.filter(f => f !== '_docID' && f !== '_deleted')

  return (
    <div className={showFields ? styles.docInfoCard : styles.docInfoCardFlat}>
      <div className={styles.docInfoHeader}>
        <span className={styles.docInfoCollection}>{collectionName}</span>
        <span className={styles.docInfoDocID} title={docID}>{docID}</span>
        <div className={styles.docInfoActions}>
          {onOpenInCollections && (
            <button className={styles.docInfoBtn} onClick={() => onOpenInCollections(collectionName, docID)}>
              <ExternalLink size={11} /> Collections
            </button>
          )}
          {onOpenInQueryRunner && (
            <button className={styles.docInfoBtn} onClick={() => onOpenInQueryRunner(`{\n  ${collectionName}(filter: { _docID: { _eq: ${JSON.stringify(docID)} } }) {\n    ${scalarFields.join('\n    ')}\n  }\n}`)}>
              <Play size={11} /> Query Runner
            </button>
          )}
        </div>
      </div>
      {showFields && doc && displayFields.length > 0 && (
        <div className={styles.docInfoFields}>
          {displayFields.map(f => (
            <div key={f} className={styles.docInfoField}>
              <span className={styles.docInfoFieldKey}>{f}</span>
              <span className={styles.docInfoFieldVal}>
                {doc[f] == null ? <span className={styles.docInfoNull}>null</span> : String(doc[f])}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Document timeline ─────────────────────────────────────────────────────────

function DocTimeline({ docID }: { docID: string }) {
  const { data, isLoading, isError } = useDocumentCommits(docID)

  if (isLoading) return <Skeleton />
  if (isError)   return <p className={styles.empty}>Failed to load commits for this document.</p>
  if (!data?.length) return <p className={styles.empty}>No commits found for this document.</p>

  const byHeight = new Map<number, Commit[]>()
  for (const c of data) {
    const arr = byHeight.get(c.height) ?? []
    arr.push(c)
    byHeight.set(c.height, arr)
  }
  const heights = [...byHeight.keys()].sort((a, b) => b - a)
  const maxHeight = heights[0] ?? 0

  return (
    <div className={styles.timelineWrap}>
      <div className={styles.timeline}>
        {heights.map(h => {
          const commits = byHeight.get(h)!
          const composites   = commits.filter(c => c.fieldName === '_C')
          const composite    = composites[0]
          const changedLinks = composite?.links.filter(l => l.fieldName && l.fieldName !== '_C') ?? []
          const parentLink   = composite?.links.find(l => l.fieldName === '_C' || l.fieldName === null)
          const isHead  = h === maxHeight
          const isRoot  = h === 1
          const isMerge = (byHeight.get(h - 1)?.filter(c => c.fieldName === '_C').length ?? 0) > 1
          return (
            <div key={h} className={styles.versionGroup}>
              <div className={styles.versionHeader}>
                <span className={styles.versionLabel}>v{h}</span>
                {isHead  && <span className={styles.tagHead}>head</span>}
                {isMerge && <span className={styles.tagMerge}>merge</span>}
                {isRoot  && <span className={styles.tagRoot}>root</span>}
                {composite && (
                  <div className={styles.versionCID}>
                    <span className={styles.cid} title={composite.cid}>{shortCID(composite.cid)}</span>
                    <CopyButton text={composite.cid} />
                    {parentLink && (
                      <span className={styles.versionLink} title={parentLink.cid}>
                        ← {shortCID(parentLink.cid)}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {changedLinks.length > 0 && (
                <div className={styles.fieldCommits}>
                  {changedLinks.map(l => (
                    <div key={l.cid} className={styles.fieldCommitRow}>
                      <FieldChip name={l.fieldName} />
                      <span className={styles.cid} title={l.cid}>{shortCID(l.cid)}</span>
                      <CopyButton text={l.cid} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── View ──────────────────────────────────────────────────────────────────────

interface Jump { docID: string; seq: number }

function isCIDInput(s: string) {
  return s.startsWith('bafy') || s.startsWith('bafk') || s.startsWith('bafz')
}

export default function CommitsView({ jump, onOpenInQueryRunner, onOpenInCollections }: {
  jump?: Jump | null
  onOpenInQueryRunner?: (query: string) => void
  onOpenInCollections?: (collection: string, docID: string) => void
}) {
  const { commitsDocID, setCommitsDocID, commitsViewMode, setCommitsViewMode } = useUIStore()
  const [input, setInput] = useState(commitsDocID ?? '')
  const [pendingCID, setPendingCID] = useState<string | null>(null)
  const docID = commitsDocID
  const viewMode = commitsViewMode
  const inputRef = useRef<HTMLInputElement>(null)

  const { data: resolvedCommit, isLoading: cidLoading, isError: cidError } = useCommitByCID(pendingCID)

  useEffect(() => {
    if (resolvedCommit) {
      setInput(resolvedCommit.docID)
      setCommitsDocID(resolvedCommit.docID)
      setCommitsViewMode('list')
      setPendingCID(null)
    }
  }, [resolvedCommit]) // eslint-disable-line react-hooks/exhaustive-deps

  function setDocID(id: string | null) { setCommitsDocID(id) }
  function setViewMode(m: 'list' | 'graph') { setCommitsViewMode(m) }

  // React to external navigation (from "View in commit graph" button)
  useEffect(() => {
    if (jump?.docID) {
      setInput(jump.docID)
      setCommitsDocID(jump.docID)
      setCommitsViewMode('graph')
    }
  }, [jump?.seq]) // eslint-disable-line react-hooks/exhaustive-deps

  function selectDoc(id: string) {
    setInput(id)
    setDocID(id)
    setViewMode('graph')
  }

  function submit() {
    const v = input.trim()
    if (!v) { setDocID(null); setPendingCID(null); return }
    if (isCIDInput(v)) {
      setPendingCID(v)
      setDocID(null)
    } else {
      setDocID(v)
      setPendingCID(null)
    }
  }

  function clear() {
    setInput('')
    setDocID(null)
    setPendingCID(null)
    inputRef.current?.focus()
  }

  const isFiltered = docID != null
  const showGraph  = isFiltered && viewMode === 'graph'

  return (
    <div className={styles.view}>

      {/* ── Search bar ────────────────────────────────────────── */}
      <div className={styles.searchBar}>
        {isFiltered && (
          <button className={styles.backBtn} onClick={clear}>
            <ArrowLeft size={12} /> All commits
          </button>
        )}
        <div className={styles.searchGroup}>
          <span className={styles.searchLabel}>Doc ID or CID</span>
          <div className={styles.searchInputWrap}>
            <input
              ref={inputRef}
              className={styles.searchInput}
              placeholder="bae-… or bafy…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
              spellCheck={false}
            />
            {input && (
              <button className={styles.clearBtn} onClick={clear}><X size={12} /></button>
            )}
          </div>
          <button className={styles.searchBtn} onClick={submit}>Search</button>
        </div>
        {isFiltered && (
          <div className={styles.searchRight}>
            <div className={styles.viewToggleGroup}>
              <button
                className={`${styles.viewToggleBtn} ${viewMode === 'list' ? styles.viewToggleBtnActive : ''}`}
                onClick={() => setViewMode('list')}
              >List</button>
              <button
                className={`${styles.viewToggleBtn} ${viewMode === 'graph' ? styles.viewToggleBtnActive : ''}`}
                onClick={() => setViewMode('graph')}
              >Graph</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Content ───────────────────────────────────────────── */}
      <div className={`${styles.body} ${showGraph ? styles.bodyGraph : ''}`}>
        {pendingCID ? (
          <div className={styles.section}>
            {cidLoading && <p className={styles.empty}>Resolving commit…</p>}
            {cidError && <p className={styles.empty}>Commit not found for CID: {pendingCID}</p>}
          </div>
        ) : showGraph ? (
          <>
            <div className={styles.metaStrip}>
              <DocInfoCard docID={docID} onOpenInCollections={onOpenInCollections} onOpenInQueryRunner={onOpenInQueryRunner} showFields={false} />
            </div>
            <CommitGraph docID={docID} onOpenInQueryRunner={onOpenInQueryRunner} onOpenInCollections={onOpenInCollections} />
          </>
        ) : isFiltered ? (
          viewMode === 'graph' ? null : (
            <>
              <div className={styles.metaStrip}>
                <DocInfoCard docID={docID} onOpenInCollections={onOpenInCollections} onOpenInQueryRunner={onOpenInQueryRunner} showFields={false} />
              </div>
              <div className={styles.section}>
                <DocTimeline docID={docID} />
              </div>
            </>
          )
        ) : (
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>All commits</h2>
              <span className={styles.sectionHint}>click a commit to see the full document history</span>
            </div>
            <RecentFeed onSelectDoc={selectDoc} />
          </div>
        )}
      </div>

    </div>
  )
}
