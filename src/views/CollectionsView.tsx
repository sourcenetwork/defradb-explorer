import { useState, useMemo, useRef, useImperativeHandle, forwardRef, useEffect, useCallback } from 'react'
import { getNamedType, isInputObjectType, isNonNullType } from 'graphql'
import { useDocuments, useDocumentCount, useDocumentAtVersion, useDocumentById, PAGE_SIZE } from '../hooks/useDocuments'
import { buildDocumentsQuery, buildSearchFilter } from '../api/graphql'
import { useCollections } from '../hooks/useCollections'
import { useGraphQLSchema } from '../hooks/useGraphQLSchema'
import {
  useCreateDocument, useUpdateDocument, useDeleteDocument,
} from '../hooks/useDocumentMutations'
import type { FormValues, TypeMap } from '../hooks/useDocumentMutations'
import { useDocumentCommits } from '../hooks/useCommits'
import { useCollectionIndexes } from '../hooks/useCollectionIndexes'
import styles from './CollectionsView.module.css'

const OPERATORS_BY_TYPE: Record<string, string[]> = {
  ID:       ['_eq', '_neq'],
  String:   ['_ilike', '_nilike', '_like', '_nlike', '_eq', '_neq'],
  Int:      ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte'],
  Float:    ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte'],
  Boolean:  ['_eq', '_neq'],
  DateTime: ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte'],
}

function HistCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <button className={`${styles.histCopyBtn} ${copied ? styles.histCopyBtnDone : ''}`} onClick={copy} title="Copy CID">
      {copied ? '✓' : (
        <svg width={10} height={10} viewBox="0 0 12 12" fill="none">
          <rect x={4} y={4} width={7} height={7} rx={1.2} stroke="currentColor" strokeWidth={1.2}/>
          <path d="M3 8H2a1 1 0 01-1-1V2a1 1 0 011-1h5a1 1 0 011 1v1" stroke="currentColor" strokeWidth={1.2}/>
        </svg>
      )}
    </button>
  )
}

export interface CollectionsViewHandle {
  openNewDoc:  () => void
  exportDocs:  () => void
}

// ── Local types ───────────────────────────────────────────────────────────────

interface FormField {
  name: string
  typeName: string
  required: boolean
}

// ── Root ──────────────────────────────────────────────────────────────────────

interface Props {
  collection:              string | null
  onViewSchema?:           (name: string) => void
  onCollectionInvalid?:    () => void
  onOpenInQueryRunner?:    (query: string) => void
}

export interface CollectionBrowserHandle {
  openNewDoc: () => void
  exportDocs: () => void
}

const CollectionsView = forwardRef<CollectionsViewHandle, Props>(function CollectionsView({ collection, onViewSchema, onCollectionInvalid, onOpenInQueryRunner }, ref) {
  const { data: collections } = useCollections()
  const browserRef = useRef<CollectionBrowserHandle>(null)

  const knownNames = collections ? new Set(collections.map(c => c.name)) : null
  const collectionValid = !collection || !knownNames || knownNames.has(collection)
  const effectiveCollection = collectionValid
    ? (collection ?? collections?.[0]?.name ?? null)
    : (collections?.[0]?.name ?? null)

  useEffect(() => {
    if (knownNames && collection && !knownNames.has(collection)) {
      onCollectionInvalid?.()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownNames, collection])

  useImperativeHandle(ref, () => ({
    openNewDoc: () => browserRef.current?.openNewDoc(),
    exportDocs: () => browserRef.current?.exportDocs(),
  }))

  if (!effectiveCollection) {
    return (
      <div className={styles.empty}>
        <p>Select a collection from the sidebar.</p>
      </div>
    )
  }

  return (
    <CollectionBrowser
      key={effectiveCollection}
      ref={browserRef}
      collection={effectiveCollection}
      onViewSchema={onViewSchema}
      onOpenInQueryRunner={onOpenInQueryRunner}
    />
  )
})

export default CollectionsView

// ── Browser ───────────────────────────────────────────────────────────────────

const CollectionBrowser = forwardRef<CollectionBrowserHandle, { collection: string; onViewSchema?: (name: string) => void; onOpenInQueryRunner?: (query: string) => void }>(function CollectionBrowser({ collection, onViewSchema, onOpenInQueryRunner }, ref) {
  const [page, setPage]           = useState(1)
  const [pageSize, setPageSize]   = useState(PAGE_SIZE)
  const [filter, setFilter]       = useState('')
  const [searchField, setSearchField] = useState('_docID')
  const [searchOp, setSearchOp]   = useState('')
  const [search, setSearch]       = useState('')

  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(filter)
      setPage(1)
    }, 350)
    return () => clearTimeout(id)
  }, [filter])

  // Reset search + op when field changes
  useEffect(() => {
    setFilter('')
    setSearch('')
    setSearchOp('')
    setPage(1)
  }, [searchField])

  const gqlSchema  = useGraphQLSchema()
  const createMut  = useCreateDocument(collection)
  const updateMut  = useUpdateDocument(collection)
  const deleteMut  = useDeleteDocument(collection)

  const formFields = useMemo((): FormField[] => {
    if (!gqlSchema) return []
    const mutationType = gqlSchema.getMutationType()
    if (!mutationType) return []
    const createField = mutationType.getFields()[`add_${collection}`]
    if (!createField) return []
    const inputArg = createField.args.find(a => a.name === 'input')
    if (!inputArg) return []
    const inputType = getNamedType(inputArg.type)
    if (!isInputObjectType(inputType)) return []
    return Object.values(inputType.getFields())
      .filter(f => !f.name.startsWith('_'))
      .map(f => ({
        name:     f.name,
        typeName: getNamedType(f.type).name,
        required: isNonNullType(f.type),
      }))
  }, [gqlSchema, collection])

  const typeMap: TypeMap = useMemo(
    () => Object.fromEntries(formFields.map(f => [f.name, f.typeName])),
    [formFields],
  )

  const searchableFields = [
    { name: '_docID', typeName: 'ID' },
    ...formFields,
  ]

  const searchFieldType = searchableFields.find(f => f.name === searchField)?.typeName ?? 'String'
  const availableOps = OPERATORS_BY_TYPE[searchFieldType] ?? OPERATORS_BY_TYPE.String
  const effectiveOp = searchOp || availableOps[0]

  // visibleFields drives the fetch — initialized empty, populated once data arrives
  const [visibleFields, setVisibleFields] = useState<Set<string>>(new Set())

  // Always include system fields plus whatever is visible
  const fetchFields = useMemo(() => {
    if (visibleFields.size === 0) return undefined
    return [...new Set(['_docID', '_deleted', ...visibleFields])]
  }, [visibleFields])

  const { data, isLoading, isError, error, refetch } = useDocuments(collection, page, search, searchField, searchFieldType, effectiveOp, pageSize, fetchFields)
  const { data: totalCount = 0 } = useDocumentCount(collection, search, searchField, searchFieldType, effectiveOp)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [showNewDoc, setShowNewDoc]   = useState(false)

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const rows      = (data?.rows   ?? []) as Record<string, unknown>[]
  const fields    = data?.fields ?? []
  const displayFields = fields.filter(f => f === '_docID' || !f.startsWith('_'))

  useEffect(() => {
    if (displayFields.length > 0) setVisibleFields(new Set(displayFields.slice(0, 7)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, fields.join(',')])

  const tableFields = displayFields.filter(f => visibleFields.has(f))
  const toggleColumn = useCallback((f: string) => {
    setVisibleFields(prev => {
      const next = new Set(prev)
      next.has(f) ? next.delete(f) : next.add(f)
      return next
    })
  }, [])

  const selected = selectedIdx !== null ? rows[selectedIdx] ?? null : null

  function handleExport() {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `${collection}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  useImperativeHandle(ref, () => ({
    openNewDoc: () => setShowNewDoc(true),
    exportDocs: handleExport,
  }))

  const offset = (page - 1) * pageSize

  const liveQuery = useMemo(() => {
    const fields = fetchFields ?? data?.fields
    if (!fields?.length) return null
    const filterArg = buildSearchFilter(search, searchField, searchFieldType, effectiveOp)
    return buildDocumentsQuery(collection, fields, pageSize, offset, filterArg)
  }, [search, searchField, searchFieldType, effectiveOp, collection, fetchFields, data?.fields, pageSize, offset])

  return (
    <div className={styles.view}>
      <StatsRow
        collection={collection}
        count={totalCount}
        fieldCount={displayFields.length}
        onViewSchema={onViewSchema}
      />
      <Toolbar
        filter={filter}
        searching={filter !== search && !!searchField}
        searchField={searchField}
        searchOp={effectiveOp}
        availableOps={availableOps}
        searchableFields={searchableFields}
        onFilterChange={f => { setFilter(f); setSelectedIdx(null) }}
        onSearchFieldChange={setSearchField}
        onSearchOpChange={setSearchOp}
        onRefresh={() => refetch()}
        allFields={displayFields}
        visibleFields={visibleFields}
        onToggleColumn={toggleColumn}
      />

      {isError && (
        <div className={styles.errorBanner}>
          <span>Query error: {(error as Error)?.message}</span>
          <button onClick={() => refetch()}>Retry</button>
        </div>
      )}

      {liveQuery && <QueryPreview query={liveQuery} hasFilter={!!search} onOpenInQueryRunner={onOpenInQueryRunner} />}

      <IndexesBar collection={collection} />

      <div className={styles.split}>
        <div className={styles.tableColumn}>
          {isLoading ? (
            <div className={styles.loadingTable}>
              {[...Array(6)].map((_, i) => (
                <div key={i} className={styles.skeletonRow}>
                  {[...Array(5)].map((_, j) => (
                    <div key={j} className={styles.skeletonCell} style={{ width: `${40 + (j * 13) % 40}%` }} />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <DocumentTable
              rows={rows as Record<string, unknown>[]}
              fields={tableFields}
              selectedIdx={selectedIdx}
              onSelect={setSelectedIdx}
            />
          )}

          <PaginationBar
            page={page}
            totalPages={totalPages}
            pageSize={pageSize}
            totalCount={totalCount}
            offset={offset}
            rowCount={rows.length}
            onChange={p => { setPage(p); setSelectedIdx(null) }}
            onPageSizeChange={size => { setPageSize(size); setPage(1); setSelectedIdx(null) }}
          />
        </div>

        {selected && (
          <DetailPanel
            key={String(selected._docID)}
            doc={selected as Record<string, unknown>}
            fields={displayFields}
            collection={collection}
            formFields={formFields}
            onClose={() => setSelectedIdx(null)}
            onUpdate={(docID, values, original) => updateMut.mutateAsync({ docID, values, typeMap, original })}
            onDelete={async (docID) => {
              await deleteMut.mutateAsync(docID)
              setSelectedIdx(null)
            }}
            updatePending={updateMut.isPending}
            deletePending={deleteMut.isPending}
          />
        )}
      </div>  {/* split */}

      {showNewDoc && (
        <NewDocModal
          collection={collection}
          formFields={formFields}
          isPending={createMut.isPending}
          error={createMut.error as Error | null}
          onClose={() => { setShowNewDoc(false); createMut.reset() }}
          onSubmit={async (values) => {
            await createMut.mutateAsync({ values, typeMap })
            setShowNewDoc(false)
          }}
        />
      )}
    </div>
  )
})

// ── Query preview ─────────────────────────────────────────────────────────────

function QueryPreview({ query, hasFilter, onOpenInQueryRunner }: { query: string; hasFilter: boolean; onOpenInQueryRunner?: (q: string) => void }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(query).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className={styles.queryPreview}>
      <button className={styles.queryPreviewToggle} onClick={() => setOpen(v => !v)}>
        <svg
          className={`${styles.queryPreviewChevron} ${open ? styles.queryPreviewChevronOpen : ''}`}
          width={8} height={8} viewBox="0 0 8 8" fill="none" aria-hidden="true"
        >
          <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Query{hasFilter && <span className={styles.queryPreviewFilterDot} />}
      </button>
      {open && (
        <div className={styles.queryPreviewBody}>
          <div className={styles.queryPreviewActions}>
            {onOpenInQueryRunner && (
              <button className={styles.queryPreviewCopy} onClick={() => onOpenInQueryRunner(query)}>
                Open in Query Runner
              </button>
            )}
            <button className={styles.queryPreviewCopy} onClick={copy}>
              {copied ? '✓' : 'Copy'}
            </button>
          </div>
          <pre className={styles.queryPreviewCode}>{query}</pre>
        </div>
      )}
    </div>
  )
}

// ── Indexes bar ───────────────────────────────────────────────────────────────

function IndexesBar({ collection }: { collection: string }) {
  const { data: indexes } = useCollectionIndexes(collection)

  return (
    <div className={styles.indexesBar}>
      <span className={styles.indexesLabel}>Indexes</span>
      <div className={styles.indexesList}>
        {!indexes?.length && (
          <span className={styles.indexesNone}>none</span>
        )}
        {indexes?.map(idx => (
          <div key={idx.ID} className={styles.indexChip}>
            <div className={styles.indexFields}>
              {idx.Fields.map(f => (
                <span key={f.Name} className={styles.indexField}>
                  {f.Name}
                  <span className={styles.indexDir}>{f.Descending ? '↓' : '↑'}</span>
                </span>
              ))}
            </div>
            {idx.Unique && <span className={styles.indexUnique}>unique</span>}
          </div>
        ))}
      </div>
    </div>
  )
}


// ── Stats row ─────────────────────────────────────────────────────────────────

function StatsRow({ collection, count, fieldCount, onViewSchema }: {
  collection: string; count: number; fieldCount: number
  onViewSchema?: (name: string) => void
}) {
  return (
    <div className={styles.statsRow}>
      <div className={styles.statsMain}>
        <h1 className={styles.statsCollection}>{collection}</h1>
        <div className={styles.statsMeta}>
          <span className={styles.statsMetaItem}>
            <span className={styles.statsMetaValue}>{count.toLocaleString()}</span>
            <span className={styles.statsMetaLabel}>documents</span>
          </span>
          <span className={styles.statsMetaSep} />
          <span className={styles.statsMetaItem}>
            <span className={styles.statsMetaValue}>{fieldCount || '—'}</span>
            <span className={styles.statsMetaLabel}>fields</span>
          </span>
        </div>
      </div>
      {onViewSchema && (
        <button className={styles.viewSchemaBtn} onClick={() => onViewSchema(collection)}>
          View schema
          <svg width={9} height={9} viewBox="0 0 10 10" fill="none">
            <path d="M2 5h6M5 2l3 3-3 3" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
    </div>
  )
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

function PaginationBar({ page, totalPages, pageSize, totalCount, offset, rowCount, onChange, onPageSizeChange }: {
  page: number; totalPages: number; pageSize: number
  totalCount: number; offset: number; rowCount: number
  onChange: (p: number) => void
  onPageSizeChange: (size: number) => void
}) {
  const [draft, setDraft] = useState(String(page))
  useEffect(() => { setDraft(String(page)) }, [page])

  const from = totalCount === 0 ? 0 : offset + 1
  const to   = Math.min(offset + pageSize, offset + rowCount)
  const large = totalPages > 10

  function commitDraft() {
    const n = parseInt(draft, 10)
    if (!isNaN(n) && n >= 1 && n <= totalPages) onChange(n)
    else setDraft(String(page))
  }

  return (
    <div className={styles.pagination}>
      <span className={styles.pageInfo}>
        {totalCount === 0 ? '—' : `${from}–${to} of ${totalCount.toLocaleString()}`}
      </span>

      <div className={styles.pageButtons}>
        <button className={styles.pageBtn} disabled={page === 1} onClick={() => onChange(page - 1)} aria-label="Previous page">‹</button>

        {large ? (
          <>
            <span className={styles.pageJumpLabel}>Page</span>
            <input
              className={styles.pageJumpInput}
              type="text"
              inputMode="numeric"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={e => { if (e.key === 'Enter') commitDraft() }}
              aria-label="Go to page"
            />
            <span className={styles.pageJumpLabel}>of {totalPages.toLocaleString()}</span>
          </>
        ) : (
          buildPageList(page, totalPages).map((p, i) =>
            p === null
              ? <span key={`ellipsis-${i}`} className={styles.pageEllipsis}>…</span>
              : <button key={p} className={`${styles.pageBtn} ${p === page ? styles.pageBtnActive : ''}`} onClick={() => onChange(p)}>{p}</button>
          )
        )}

        <button className={styles.pageBtn} disabled={page === totalPages} onClick={() => onChange(page + 1)} aria-label="Next page">›</button>
      </div>

      <div className={styles.pageSizeWrap}>
        <select className={styles.pageSizeSelect} value={pageSize} onChange={e => onPageSizeChange(Number(e.target.value))}>
          {PAGE_SIZE_OPTIONS.map(n => (
            <option key={n} value={n}>{n} / page</option>
          ))}
        </select>
        <svg className={styles.searchFieldCaret} width={8} height={8} viewBox="0 0 8 8" fill="none" aria-hidden="true">
          <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    </div>
  )
}

function buildPageList(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: (number | null)[] = [1]
  if (current > 3) pages.push(null)
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) pages.push(p)
  if (current < total - 2) pages.push(null)
  pages.push(total)
  return pages
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function Toolbar({ filter, searching, searchField, searchOp, availableOps, searchableFields, onFilterChange, onSearchFieldChange, onSearchOpChange, onRefresh, allFields, visibleFields, onToggleColumn }: {
  filter: string
  searching: boolean
  searchField: string
  searchOp: string
  availableOps: string[]
  searchableFields: { name: string; typeName: string }[]
  onFilterChange: (f: string) => void
  onSearchFieldChange: (f: string) => void
  onSearchOpChange: (op: string) => void
  onRefresh: () => void
  allFields: string[]
  visibleFields: Set<string>
  onToggleColumn: (f: string) => void
}) {
  const [colsOpen, setColsOpen] = useState(false)
  const colsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!colsOpen) return
    function handleClick(e: MouseEvent) {
      if (colsRef.current && !colsRef.current.contains(e.target as Node)) setColsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [colsOpen])

  const hiddenCount = allFields.filter(f => !visibleFields.has(f)).length
  const wildcardOp = ['_ilike', '_nilike', '_like', '_nlike'].includes(searchOp)

  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarSearch}>
        <div className={styles.searchFieldWrap}>
          <select
            className={styles.searchFieldSelect}
            value={searchField}
            onChange={e => onSearchFieldChange(e.target.value)}
          >
            <option value="">Field…</option>
            {searchableFields.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
          </select>
          <svg className={styles.searchFieldCaret} width={8} height={8} viewBox="0 0 8 8" fill="none" aria-hidden="true">
            <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <span className={styles.searchFieldSep} />
        <div className={styles.searchFieldWrap}>
          <select
            className={`${styles.searchFieldSelect} ${styles.searchOpSelect}`}
            value={searchOp}
            disabled={!searchField}
            onChange={e => onSearchOpChange(e.target.value)}
          >
            {availableOps.map(o => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
          <svg className={styles.searchFieldCaret} width={8} height={8} viewBox="0 0 8 8" fill="none" aria-hidden="true">
            <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <span className={styles.searchFieldSep} />
        {searching ? (
          <span className={styles.toolbarSpinner} aria-hidden="true" />
        ) : (
          <svg width={11} height={11} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, color: 'var(--gray-600)' }}>
            <circle cx={7} cy={7} r={5} stroke="currentColor" strokeWidth={1.5}/>
            <line x1={11} y1={11} x2={14} y2={14} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
          </svg>
        )}
        <div className={styles.searchInputWrap}>
          {wildcardOp && <span className={styles.searchWildcard}>%</span>}
          <input
            type="text"
            placeholder={searchField ? `Search by ${searchField}…` : 'Choose a field first…'}
            value={filter}
            disabled={!searchField}
            onChange={e => onFilterChange(e.target.value)}
          />
          {wildcardOp && <span className={styles.searchWildcard}>%</span>}
          {filter && (
            <button className={styles.searchClear} onClick={() => onFilterChange('')} aria-label="Clear search">
              <svg width={8} height={8} viewBox="0 0 8 8" fill="none" aria-hidden="true">
                <line x1={1} y1={1} x2={7} y2={7} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round"/>
                <line x1={7} y1={1} x2={1} y2={7} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className={styles.toolbarSep} />
      <div className={styles.colsWrap} ref={colsRef}>
        <button
          className={`${styles.btnSm} ${colsOpen ? styles.btnCyan : ''}`}
          onClick={() => setColsOpen(v => !v)}
        >
          Columns{hiddenCount > 0 ? ` · ${allFields.length - hiddenCount}/${allFields.length}` : ''}
        </button>
        {colsOpen && (
          <div className={styles.colsDropdown}>
            {allFields.map(f => (
              <label key={f} className={styles.colsItem}>
                <input
                  type="checkbox"
                  checked={visibleFields.has(f)}
                  onChange={() => onToggleColumn(f)}
                  className={styles.colsCheckbox}
                />
                <span className={styles.colsLabel}>{f}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <button className={`${styles.btnSm} ${styles.btnCyan}`} onClick={onRefresh}>↺ Refresh</button>
    </div>
  )
}

// ── Document table ────────────────────────────────────────────────────────────

function DocumentTable({ rows, fields, selectedIdx, onSelect }: {
  rows:        Record<string, unknown>[]
  fields:      string[]
  selectedIdx: number | null
  onSelect:    (i: number) => void
}) {
  if (rows.length === 0) {
    return (
      <div className={styles.emptyTable}>
        <p>No documents in this collection.</p>
      </div>
    )
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th style={{ width: 36 }} />
            {fields.map(f => <th key={f}>{f}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={String(row._docID ?? i)}
              className={i === selectedIdx ? styles.rowSelected : ''}
              onClick={() => onSelect(i)}
            >
              <td><span className={`${styles.checkbox} ${i === selectedIdx ? styles.checkboxChecked : ''}`} /></td>
              {fields.map(f => (
                <td key={f} className={f === '_docID' ? styles.tdDocId : f === fields[1] ? styles.tdPrimary : ''}>
                  {formatCell(f, row[f])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatCell(field: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (field === '_docID') return String(value).slice(0, 18) + '…'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// ── Detail panel ──────────────────────────────────────────────────────────────

type PanelMode = 'view' | 'edit' | 'history'

function DetailPanel({ doc, fields, collection, formFields, onClose, onUpdate, onDelete, updatePending, deletePending }: {
  doc:           Record<string, unknown>
  fields:        string[]
  collection:    string
  formFields:    FormField[]
  onClose:       () => void
  onUpdate:      (docID: string, values: FormValues, original: FormValues) => Promise<unknown>
  onDelete:      (docID: string) => Promise<void>
  updatePending: boolean
  deletePending: boolean
}) {
  const docID = String(doc._docID ?? '')
  const [mode, setMode]                 = useState<PanelMode>('view')
  const [editValues, setEditValues]     = useState<FormValues>({})
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [mutErr, setMutErr]             = useState<string | null>(null)
  const [openCids, setOpenCids] = useState<Set<string>>(new Set())

  function toggleCid(cid: string) {
    setOpenCids(prev => {
      const next = new Set(prev)
      next.has(cid) ? next.delete(cid) : next.add(cid)
      return next
    })
  }

  // Always fetched — drives both the version badge in the header and the history panel
  const { data: commits, isLoading: histLoading, error: histError, refetch: refetchCommits } = useDocumentCommits(docID)

  // Full document fetch for the Fields view (table rows only carry visible columns)
  const { data: fullDoc } = useDocumentById(collection, docID, fields)
  const currentVersion = commits?.[0]?.height ?? null

  // Fields to show in the edit form — fall back to doc keys if schema not loaded
  const editableFields: FormField[] = formFields.length > 0
    ? formFields
    : fields.filter(f => f !== '_docID' && !f.startsWith('_')).map(f => ({ name: f, typeName: 'String', required: false }))

  function startEdit() {
    const source = fullDoc ?? doc
    const init: FormValues = {}
    for (const f of editableFields) {
      const v = source[f.name]
      if (v !== null && v !== undefined) init[f.name] = String(v)
    }
    setEditValues(init)
    setMutErr(null)
    setMode('edit')
  }

  async function saveEdit() {
    try {
      setMutErr(null)
      const source = fullDoc ?? doc
      const original: FormValues = {}
      for (const f of editableFields) {
        const v = source[f.name]
        if (v !== null && v !== undefined) original[f.name] = String(v)
      }
      await onUpdate(docID, editValues, original)
      setMode('view')
      refetchCommits()
    } catch (e) {
      setMutErr((e as Error).message)
    }
  }

  async function confirmDelete() {
    try {
      await onDelete(docID)
    } catch (e) {
      setMutErr((e as Error).message)
      setDeleteConfirm(false)
    }
  }

  return (
    <aside className={styles.detail}>
      {/* Header */}
      <div className={styles.detailHeader}>
        <div className={styles.detailNameRow}>
          <p className={styles.detailName}>{collection}</p>
          {currentVersion !== null && (
            <span className={styles.detailVersion}>v{currentVersion}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {mode === 'edit' && (
            <>
              <button className={styles.btnSmEdit} onClick={() => { setMode('view'); setMutErr(null) }}>Cancel</button>
              <button className={`${styles.btnSmEdit} ${styles.btnSmEditSave}`} onClick={saveEdit} disabled={updatePending}>
                {updatePending ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
          <button className={styles.panelCloseBtn} onClick={onClose} aria-label="Close panel">✕</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className={styles.detailTabs}>
        <button className={`${styles.detailTab} ${mode === 'view' ? styles.detailTabActive : ''}`} onClick={() => setMode('view')}>
          Fields
        </button>
        <button className={`${styles.detailTab} ${mode === 'edit' ? styles.detailTabActive : ''}`} onClick={startEdit}>
          Edit
        </button>
        <button className={`${styles.detailTab} ${mode === 'history' ? styles.detailTabActive : ''}`} onClick={() => setMode('history')}>
          History
          {currentVersion !== null && (
            <span className={`${styles.detailTabBadge} ${mode === 'history' ? styles.detailTabBadgeActive : ''}`}>{currentVersion}</span>
          )}
        </button>
      </div>

      {mutErr && <div className={styles.detailError}>{mutErr}</div>}

      {/* Body */}
      <div className={styles.detailBody}>
        {mode === 'view' && (
          <>
            <p className={styles.detailSectionLabel}>Fields</p>
            {fields.map(f => {
              const viewDoc = fullDoc ?? doc
              return (
                <div key={f} className={styles.fieldGroup}>
                  <div className={styles.fieldKeyRow}>
                    <p className={styles.fieldKey}>{f}</p>
                    {f === '_docID' && viewDoc[f] != null && (
                      <HistCopyButton text={String(viewDoc[f])} />
                    )}
                  </div>
                  <p className={`${styles.fieldVal} ${f === '_docID' ? styles.fieldValMono : ''}`}>
                    {viewDoc[f] !== undefined && viewDoc[f] !== null
                      ? String(viewDoc[f])
                      : <span style={{ color: 'var(--gray-600)' }}>null</span>
                    }
                  </p>
                </div>
              )
            })}
          </>
        )}

        {mode === 'edit' && (
          <>
            <p className={styles.detailSectionLabel}>Edit fields</p>
            {editableFields.map(f => (
              <div key={f.name} className={styles.fieldGroup}>
                <p className={styles.fieldKey}>
                  {f.name}&thinsp;<span className={styles.fieldKeyType}>{f.typeName}</span>
                  {f.required && <span className={styles.fieldKeyRequired}> *</span>}
                </p>
                {f.typeName === 'Boolean' ? (
                  <select
                    className={styles.fieldInput}
                    value={editValues[f.name] ?? ''}
                    onChange={e => setEditValues(p => ({ ...p, [f.name]: e.target.value }))}
                  >
                    <option value="">— null —</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    className={styles.fieldInput}
                    type={f.typeName === 'Int' || f.typeName === 'Float' ? 'number' : 'text'}
                    value={editValues[f.name] ?? ''}
                    onChange={e => setEditValues(p => ({ ...p, [f.name]: e.target.value }))}
                    placeholder={f.required ? 'required' : 'optional'}
                  />
                )}
              </div>
            ))}
          </>
        )}

        {mode === 'history' && (
          <>
            <div className={styles.detailSectionLabelRow}>
              <p className={styles.detailSectionLabel} style={{ color: 'var(--gray-600)', fontSize: 11 }}>
                {docID.slice(0, 20)}…
              </p>
              <button className={styles.histRefreshBtn} onClick={() => refetchCommits()} disabled={histLoading} title="Refresh">
                ↺
              </button>
            </div>
            {histLoading && <p className={styles.histEmpty}>Loading…</p>}
            {histError && <p className={styles.histEmpty} style={{ color: '#FF5F57' }}>{(histError as Error).message}</p>}
            {!histLoading && !histError && commits?.length === 0 && (
              <p className={styles.histEmpty}>No commits found.</p>
            )}
            {commits && (() => {
              const byHeight = new Map<number, typeof commits>()
              for (const c of commits) {
                if (!byHeight.has(c.height)) byHeight.set(c.height, [])
                byHeight.get(c.height)!.push(c)
              }
              // Build a map from height → composite CID for parent lookups
              const compositeCidByHeight = new Map<number, string>()
              for (const [h, group] of byHeight) {
                const comp = group.find(c => c.fieldName === '_C')
                if (comp) compositeCidByHeight.set(h, comp.cid)
              }
              return [...byHeight.entries()]
                .sort(([a], [b]) => b - a)
                .map(([height, group]) => {
                  const composite    = group.find(c => c.fieldName === '_C')
                  const cid          = composite?.cid ?? group[0]?.cid ?? ''
                  const parentCID    = compositeCidByHeight.get(height - 1) ?? null
                  // All links on a composite (excluding the _C back-pointer) are the fields changed in that commit
                  const changedLinks = composite?.links.filter(l => l.fieldName && l.fieldName !== '_C') ?? []
                  const shortCid     = cid.length > 20 ? `${cid.slice(0, 10)}…${cid.slice(-6)}` : cid
                  const shortParent  = parentCID && parentCID.length > 16 ? `${parentCID.slice(0, 8)}…${parentCID.slice(-4)}` : parentCID
                  const isOpen = openCids.has(cid)
                  return (
                    <div key={height} className={`${styles.histVersion} ${isOpen ? styles.histVersionOpen : ''}`} onClick={() => toggleCid(cid)}>
                      <div className={styles.histVersionHead}>
                        <span className={styles.histHeight}>v{height}</span>
                        <div className={styles.histCidRow}>
                          <span className={styles.histCid} title={cid}>{shortCid}</span>
                          <span onClick={e => e.stopPropagation()}>
                            <HistCopyButton text={cid} />
                          </span>
                        </div>
                        {shortParent && (
                          <span className={styles.histParent} title={parentCID ?? ''}>← {shortParent}</span>
                        )}
                        <span className={styles.histChevron}>{isOpen ? '▲' : '▼'}</span>
                      </div>
                      {changedLinks.length > 0 && (
                        <div className={styles.histFieldTags}>
                          {changedLinks.map(l => (
                            <span key={l.cid} className={`${styles.histField} ${styles.histFieldChanged}`} title={l.cid}>
                              {l.fieldName}
                            </span>
                          ))}
                        </div>
                      )}
                      {isOpen && (
                        <VersionSnapshot
                          collection={collection}
                          cid={cid}
                          parentCid={parentCID}
                          changedFields={new Set(changedLinks.map(l => l.fieldName ?? ''))}
                        />
                      )}
                    </div>
                  )
                })
            })()}
          </>
        )}
      </div>

      {/* Footer actions */}
      <div className={styles.detailActions}>
        {!deleteConfirm ? (
          <>
            <button
              className={`${styles.btnSmAction} ${styles.btnSmActionDanger}`}
              onClick={() => setDeleteConfirm(true)}
            >
              Delete
            </button>
          </>
        ) : (
          <div className={styles.deleteConfirm}>
            <span className={styles.deleteConfirmLabel}>Delete this document?</span>
            <button
              className={`${styles.btnSmAction} ${styles.btnSmActionDangerFill}`}
              onClick={confirmDelete}
              disabled={deletePending}
            >
              {deletePending ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button
              className={`${styles.btnSmAction} ${styles.btnSmActionSecondary}`}
              onClick={() => setDeleteConfirm(false)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

// ── Version snapshot ──────────────────────────────────────────────────────────

function VersionSnapshot({ collection, cid, parentCid, changedFields }: {
  collection:    string
  cid:           string
  parentCid:     string | null
  changedFields: Set<string>
}) {
  const changedFieldList = useMemo(() => [...changedFields], [changedFields])
  const { data, isLoading, isError, error } = useDocumentAtVersion(collection, cid, changedFieldList)
  const { data: prev } = useDocumentAtVersion(collection, parentCid, changedFieldList)

  if (isLoading) return <div className={styles.snapshotWrap}><p className={styles.histEmpty}>Loading…</p></div>
  if (isError)   return <div className={styles.snapshotWrap}><p className={styles.histEmpty} style={{ color: '#FF5F57' }}>{(error as Error).message}</p></div>
  if (!data)     return <div className={styles.snapshotWrap}><p className={styles.histEmpty}>No data returned.</p></div>

  const displayFields = changedFieldList.filter(f => f !== '_docID' && !f.startsWith('_'))

  function fmt(v: unknown) {
    if (v === null || v === undefined) return null
    return String(v)
  }

  return (
    <div className={styles.snapshotWrap}>
      {displayFields.map(f => {
        const curr   = fmt(data[f])
        const before = prev ? fmt(prev[f]) : null
        const isAdd  = before === null && curr !== null
        const isDel  = curr === null && before !== null
        const isMod  = !isAdd && !isDel && before !== curr

        return (
          <div key={f} className={styles.diffBlock}>
            <span className={styles.diffField}>{f}</span>
            <div className={styles.diffLines}>
              {(isDel || isMod) && (
                <div className={styles.diffLineRemove}>
                  <span className={styles.diffSign}>−</span>
                  <span className={styles.diffValue}>{before}</span>
                </div>
              )}
              {(isAdd || isMod) && (
                <div className={styles.diffLineAdd}>
                  <span className={styles.diffSign}>+</span>
                  <span className={styles.diffValue}>{curr}</span>
                </div>
              )}
              {!isAdd && !isDel && !isMod && (
                <div className={styles.diffLineUnchanged}>
                  <span className={styles.diffSign}> </span>
                  <span className={styles.diffValue}>{curr ?? <span className={styles.snapshotNull}>null</span>}</span>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── New document modal ────────────────────────────────────────────────────────

function NewDocModal({ collection, formFields, isPending, error, onClose, onSubmit }: {
  collection: string
  formFields: FormField[]
  isPending:  boolean
  error:      Error | null
  onClose:    () => void
  onSubmit:   (values: FormValues) => Promise<void>
}) {
  const [values, setValues] = useState<FormValues>({})

  // Fall back to a generic text field if schema hasn't loaded yet
  const fields: FormField[] = formFields.length > 0
    ? formFields
    : [{ name: '(schema loading…)', typeName: 'String', required: false }]

  function set(name: string, value: string) {
    setValues(p => ({ ...p, [name]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await onSubmit(values)
  }

  return (
    <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <p className={styles.modalTitle}>New {collection} document</p>
          <button className={styles.modalClose} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className={styles.modalBody}>
            {fields.map(f => (
              <div key={f.name} className={styles.formGroup}>
                <label className={styles.formLabel}>
                  {f.name}
                  <span className={styles.formType}>{f.typeName}</span>
                  {f.required && <span className={styles.formRequired}>*</span>}
                </label>
                {f.typeName === 'Boolean' ? (
                  <select
                    className={styles.formInput}
                    value={values[f.name] ?? ''}
                    onChange={e => set(f.name, e.target.value)}
                  >
                    <option value="">— null —</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    className={styles.formInput}
                    type={f.typeName === 'Int' || f.typeName === 'Float' ? 'number' : 'text'}
                    value={values[f.name] ?? ''}
                    onChange={e => set(f.name, e.target.value)}
                    placeholder={f.required ? 'required' : 'optional'}
                    required={f.required}
                  />
                )}
              </div>
            ))}

            {error && <p className={styles.modalError}>{error.message}</p>}
          </div>

          <div className={styles.modalFooter}>
            <button type="button" className={styles.btnSm} onClick={onClose}>Cancel</button>
            <button type="submit" className={`${styles.btnSm} ${styles.btnPrimary}`} disabled={isPending || formFields.length === 0}>
              {isPending ? 'Creating…' : 'Create document'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
