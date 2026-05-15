import { useState, useRef } from 'react'
import { useRecentCommits, useDocumentCommits } from '../hooks/useCommits'
import type { Commit } from '../hooks/useCommits'
import styles from './CommitsView.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortCID(cid: string) {
  return cid.length > 20 ? `${cid.slice(0, 10)}…${cid.slice(-6)}` : cid
}


function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ''}`} onClick={copy} title={text}>
      {copied ? '✓' : <CopyIcon />}
    </button>
  )
}

function CopyIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 12 12" fill="none">
      <rect x={4} y={4} width={7} height={7} rx={1.2} stroke="currentColor" strokeWidth={1.2}/>
      <path d="M3 8H2a1 1 0 01-1-1V2a1 1 0 011-1h5a1 1 0 011 1v1" stroke="currentColor" strokeWidth={1.2}/>
    </svg>
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

// ── Document summary (one row per doc) ───────────────────────────────────────

interface DocSummary {
  docID: string
  maxHeight: number        // total number of writes
  latestFields: string[]   // fields changed in the most recent write
  latestCID: string | null // composite CID of the most recent write
}

function groupIntoDocSummaries(commits: Commit[]): DocSummary[] {
  // Commits arrive ordered by height DESC globally. For each docID, the first
  // composite commit we see is its latest version.
  const map = new Map<string, DocSummary>()
  for (const c of commits) {
    let doc = map.get(c.docID)
    if (!doc) {
      doc = { docID: c.docID, maxHeight: c.height, latestFields: [], latestCID: null }
      map.set(c.docID, doc)
    }
    // First _C commit for this doc = its latest composite; all non-_C links are the changed fields
    if (c.fieldName === '_C' && doc.latestCID === null) {
      doc.latestCID = c.cid
      doc.latestFields = c.links
        .filter(l => l.fieldName && l.fieldName !== '_C')
        .map(l => l.fieldName!)
    }
  }
  // Sort by most writes (highest version) descending
  return [...map.values()].sort((a, b) => b.maxHeight - a.maxHeight || a.docID.localeCompare(b.docID))
}

function RecentFeed({ onSelectDoc }: { onSelectDoc: (id: string) => void }) {
  const [limit, setLimit] = useState(200)
  const { data, isLoading, isError } = useRecentCommits(limit)

  if (isLoading) return <Skeleton />
  if (isError)   return <p className={styles.empty}>Failed to load commits.</p>
  if (!data?.length) return <p className={styles.empty}>No commits found.</p>

  const docs = groupIntoDocSummaries(data)

  return (
    <div className={styles.feedWrap}>
      <div className={styles.commitList}>
        {docs.map(doc => (
          <DocSummaryRow key={doc.docID} doc={doc} onSelectDoc={onSelectDoc} />
        ))}
      </div>
      {data.length === limit && (
        <button className={styles.loadMore} onClick={() => setLimit(l => l + 200)}>
          Load more
        </button>
      )}
    </div>
  )
}

function DocSummaryRow({ doc, onSelectDoc }: { doc: DocSummary; onSelectDoc: (id: string) => void }) {
  return (
    <div className={styles.recentRow}>
      <HeightBadge height={doc.maxHeight} />
      <button className={styles.recentDocID} title={doc.docID} onClick={() => onSelectDoc(doc.docID)}>
        {doc.docID}
      </button>
      <div className={styles.fieldList}>
        {doc.latestFields.map(f => <FieldChip key={f} name={f} />)}
        {doc.latestFields.length === 0 && <span className={styles.compositeLabel}>no field changes</span>}
      </div>
      {doc.latestCID && (
        <div className={styles.cidCell}>
          <span className={styles.cid} title={doc.latestCID}>{shortCID(doc.latestCID)}</span>
          <CopyButton text={doc.latestCID} />
        </div>
      )}
    </div>
  )
}

// ── Document timeline ─────────────────────────────────────────────────────────

const PAGE = 50

function DocTimeline({ docID }: { docID: string }) {
  const [limit, setLimit] = useState(PAGE)
  const { data, isLoading, isError } = useDocumentCommits(docID, limit)

  if (isLoading) return <Skeleton />
  if (isError)   return <p className={styles.empty}>Failed to load commits for this document.</p>
  if (!data?.length) return <p className={styles.empty}>No commits found for this document.</p>

  const hitLimit = data.length === limit

  // Group by height (already ordered DESC).
  // If we hit the fetch limit the last height group may be incomplete — drop it
  // so we never show a partial version. It reappears when the user loads more.
  const byHeight = new Map<number, Commit[]>()
  for (const c of data) {
    const arr = byHeight.get(c.height) ?? []
    arr.push(c)
    byHeight.set(c.height, arr)
  }
  const heights = [...byHeight.keys()].sort((a, b) => b - a)
  const visibleHeights = hitLimit ? heights.slice(0, -1) : heights

  return (
    <div className={styles.timelineWrap}>
      <div className={styles.timeline}>
        {visibleHeights.map(h => {
          const commits = byHeight.get(h)!
          const composite    = commits.find(c => c.fieldName === '_C')
          const changedLinks = composite?.links.filter(l => l.fieldName && l.fieldName !== '_C') ?? []
          const parentLink   = composite?.links.find(l => l.fieldName === '_C' || l.fieldName === null)
          return (
            <div key={h} className={styles.versionGroup}>
              <div className={styles.versionHeader}>
                <span className={styles.versionLabel}>Version {h}</span>
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
      {hitLimit && (
        <button className={styles.loadMore} onClick={() => setLimit(l => l + PAGE)}>
          Load more versions
        </button>
      )}
    </div>
  )
}

// ── View ──────────────────────────────────────────────────────────────────────

export default function CommitsView() {
  const [input, setInput] = useState('')
  const [docID, setDocID] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function selectDoc(id: string) {
    setInput(id)
    setDocID(id)
  }

  function submit() {
    const val = input.trim()
    setDocID(val || null)
  }

  function clear() {
    setInput('')
    setDocID(null)
    inputRef.current?.focus()
  }

  const isFiltered = docID != null

  return (
    <div className={styles.view}>

      {/* ── Search bar ────────────────────────────────────────── */}
      <div className={styles.searchBar}>
        <div className={styles.searchGroup}>
          <span className={styles.searchLabel}>Document ID</span>
          <div className={styles.searchInputWrap}>
            <input
              ref={inputRef}
              className={styles.searchInput}
              placeholder="bae-…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
              spellCheck={false}
            />
            {input && (
              <button className={styles.clearBtn} onClick={clear}>×</button>
            )}
          </div>
          <button className={styles.searchBtn} onClick={submit}>Search</button>
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────── */}
      <div className={styles.body}>
        {isFiltered ? (
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <button className={styles.backBtn} onClick={clear}>
                <svg width={12} height={12} viewBox="0 0 12 12" fill="none">
                  <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                All documents
              </button>
              <span className={styles.sectionHeadSep}>›</span>
              <h2 className={styles.sectionTitle}>Commit history</h2>
              <span className={styles.sectionDocID} title={docID}>{docID}</span>
              <CopyButton text={docID} />
            </div>
            <DocTimeline docID={docID} />
          </div>
        ) : (
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>All documents</h2>
              <span className={styles.sectionHint}>sorted by write count — click a document to see its full history</span>
            </div>
            <RecentFeed onSelectDoc={selectDoc} />
          </div>
        )}
      </div>

    </div>
  )
}
