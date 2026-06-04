import { useState, useMemo, useRef, useImperativeHandle, forwardRef, useEffect, useCallback } from 'react'
import { Copy, Check, ChevronDown, Search, X, ArrowRight, RotateCw, GitBranch, Pencil } from 'lucide-react'
import CommitGraph from '../components/CommitGraph'
import { getNamedType, isInputObjectType, isNonNullType, isListType, GraphQLNonNull } from 'graphql'
import type { GraphQLOutputType } from 'graphql'
import { useDocuments, useDocumentCount, useDocumentAtVersion, useDocumentById } from '../hooks/useDocuments'
import { buildDocumentsQuery, buildSearchFilter, executeGraphQL } from '../api/graphql'
import { useCollections } from '../hooks/useCollections'
import { useViews, useRefreshView } from '../hooks/useViews'
import { useGraphQLSchema } from '../hooks/useGraphQLSchema'
import {
  useCreateDocument, useUpdateDocument, useDeleteDocument,
} from '../hooks/useDocumentMutations'
import { validateValues } from '../hooks/useDocumentMutations'
import type { FormValues, TypeMap } from '../hooks/useDocumentMutations'
import { useDocumentCommits } from '../hooks/useCommits'
import { useCollectionIndexes } from '../hooks/useCollectionIndexes'
import { useUIStore } from '../store/uiStore'
import { useConfig } from '../context/ConfigContext'
import styles from './CollectionsView.module.css'

const OPERATORS_BY_TYPE: Record<string, string[]> = {
  ID:       ['_eq', '_neq'],
  String:   ['_ilike', '_nilike', '_like', '_nlike', '_eq', '_neq'],
  Int:      ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte'],
  Float:    ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte'],
  Float32:  ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte'],
  Float64:  ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte'],
  Boolean:  ['_eq', '_neq'],
  DateTime: ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte'],
  Blob:     ['_eq', '_neq'],
  JSON:     ['_eq', '_neq'],
}

function FieldValue({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false)

  if (value === null || value === undefined)
    return <span style={{ color: 'var(--gray-600)' }}>null</span>

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      if (!expanded)
        return <button className={styles.fieldValExpand} onClick={() => setExpanded(true)}>[{value.length} item{value.length !== 1 ? 's' : ''}]</button>
      return (
        <span>
          <pre className={styles.fieldValPre}>{JSON.stringify(value, null, 2)}</pre>
          <button className={styles.fieldValExpand} onClick={() => setExpanded(false)}>collapse</button>
        </span>
      )
    }
    const obj = value as Record<string, unknown>
    if (obj._docID)
      return <span className={styles.fieldValRef}>→ {String(obj._docID)}</span>
    if (!expanded)
      return <button className={styles.fieldValExpand} onClick={() => setExpanded(true)}>{'{object}'}</button>
    return (
      <span>
        <pre className={styles.fieldValPre}>{JSON.stringify(value, null, 2)}</pre>
        <button className={styles.fieldValExpand} onClick={() => setExpanded(false)}>collapse</button>
      </span>
    )
  }

  const str = String(value)
  if (str.length > 200) {
    if (/^[A-Za-z0-9+/]+=*$/.test(str))
      return <span className={styles.fieldValMuted}>[binary ~{Math.round(str.length * 0.75 / 1024)} KB]</span>
    if (!expanded)
      return <span>{str.slice(0, 200)}<span className={styles.fieldValMuted}>…</span> <button className={styles.fieldValExpand} onClick={() => setExpanded(true)}>more</button></span>
    return <span>{str} <button className={styles.fieldValExpand} onClick={() => setExpanded(false)}>less</button></span>
  }

  return <span>{str}</span>
}

function HistCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <button className={`${styles.histCopyBtn} ${copied ? styles.histCopyBtnDone : ''}`} onClick={copy} title="Copy CID">
      {copied ? <Check size={10} /> : <Copy size={10} />}
    </button>
  )
}

export interface CollectionsViewHandle {
  openNewDoc:  () => void
  exportDocs:  () => void
  openDoc:     (docID: string) => void
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
  onViewCommitGraph?:      (docID: string) => void
}

export interface CollectionBrowserHandle {
  openNewDoc: () => void
  exportDocs: () => void
  openDoc:    (docID: string) => void
}

const CollectionsView = forwardRef<CollectionsViewHandle, Props>(function CollectionsView({ collection, onViewSchema, onCollectionInvalid, onOpenInQueryRunner }, ref) {
  const { data: collections } = useCollections()
  const { data: views } = useViews()
  const browserRef = useRef<CollectionBrowserHandle>(null)

  const knownNames = useMemo(
    () => (collections || views) ? new Set([...(collections ?? []).map(c => c.name), ...(views ?? []).map(v => v.name)]) : null,
    [collections, views],
  )
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
    openDoc:    (docID: string) => browserRef.current?.openDoc(docID),
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
  const pageSize    = useUIStore(s => s.collectionsPageSize)
  const setPageSize = useUIStore(s => s.setCollectionsPageSize)
  const [page, setPage]           = useState(1)
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

  const { data: collections } = useCollections()
  const { data: views } = useViews()
  const collectionMeta = collections?.find(c => c.name === collection)
  const viewMeta = views?.find(v => v.name === collection)
  const refreshMut = useRefreshView()

  // Relation object fields (e.g. "author") need { _docID } sub-selection in GraphQL.
  // Detected via relation_name on the REST collection descriptor, excluding the _id FK scalars.
  const relationFields = useMemo(() =>
    new Set(
      (collectionMeta?.fields ?? [])
        .filter(f => f.relation_name && !f.name.endsWith('_id'))
        .map(f => f.name)
    ),
    [collectionMeta],
  )

  const gqlSchema  = useGraphQLSchema()

  // Object-type fields in views that were excluded from the table query (need sub-selection)
  const viewNestedFields = useMemo(() => {
    if (!viewMeta || !gqlSchema) return []
    const queryType = gqlSchema.getQueryType()
    const collField = queryType?.getFields()[collection]
    if (!collField) return []
    const collType = getNamedType(collField.type)
    if (!('getFields' in collType)) return []
    const SKIP = new Set(['AVG', 'COUNT', 'MAX', 'MIN', 'SUM', 'SIMILARITY', 'GROUP'])
    return Object.entries((collType as { getFields(): Record<string, { type: GraphQLOutputType }> }).getFields())
      .filter(([name, field]) => !name.startsWith('_') && !SKIP.has(name) && 'getFields' in getNamedType(field.type))
      .map(([name, field]) => {
        const nestedType = getNamedType(field.type) as { getFields(): Record<string, { type: GraphQLOutputType }> }
        const subFields = Object.entries(nestedType.getFields())
          .filter(([fn, ff]) => !fn.startsWith('_') && !SKIP.has(fn) && !('getFields' in getNamedType(ff.type)))
          .map(([fn]) => fn)
        return { name, subFields }
      })
  }, [viewMeta, gqlSchema, collection])

  // Split into single-object relations (safe: fetch { _docID }) vs list/many relations
  // (unsafe in table: could return thousands of rows — excluded from column query).
  const { singleRelationFields, listRelationFields } = useMemo(() => {
    const single = new Set<string>()
    const list   = new Set<string>()
    if (!gqlSchema) return { singleRelationFields: single, listRelationFields: list }
    const queryType = gqlSchema.getQueryType()
    if (!queryType) return { singleRelationFields: relationFields, listRelationFields: list }
    const collectionField = queryType.getFields()[collection]
    if (!collectionField) return { singleRelationFields: relationFields, listRelationFields: list }
    const collType = getNamedType(collectionField.type)
    const typeFields = 'getFields' in collType ? (collType as { getFields(): Record<string, { type: GraphQLOutputType }> }).getFields() : {}
    for (const name of relationFields) {
      const f = typeFields[name]
      if (!f) { single.add(name); continue }
      // Unwrap NonNull to check if the inner type is a list
      const inner = f.type instanceof GraphQLNonNull ? f.type.ofType : f.type
      if (isListType(inner)) list.add(name)
      else single.add(name)
    }
    return { singleRelationFields: single, listRelationFields: list }
  }, [gqlSchema, collection, relationFields])
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

  // visibleFields drives the fetch — initialized empty, populated once data arrives
  const [visibleFields, setVisibleFields] = useState<Set<string>>(new Set())
  // Cache the full field list returned by the first query so we know which system
  // fields (like _docID) actually exist for this collection/view.
  const [schemaFields, setSchemaFields] = useState<string[] | null>(null)

  const hasDocID = !schemaFields || schemaFields.includes('_docID')

  const SKIP_FIELDS = new Set(['AVG', 'COUNT', 'MAX', 'MIN', 'SUM', 'SIMILARITY', 'GROUP'])
  const viewFields = useMemo((): FormField[] => {
    if (!viewMeta || !gqlSchema) return []
    const queryType = gqlSchema.getQueryType()
    if (!queryType) return []
    const collField = queryType.getFields()[collection]
    if (!collField) return []
    const collType = getNamedType(collField.type)
    if (!('getFields' in collType)) return []
    return Object.values((collType as { getFields(): Record<string, { name: string; type: GraphQLOutputType }> }).getFields())
      .filter(f => !f.name.startsWith('_') && !SKIP_FIELDS.has(f.name) && !('getFields' in getNamedType(f.type)))
      .map(f => ({ name: f.name, typeName: getNamedType(f.type).name, required: false }))
  }, [viewMeta, gqlSchema, collection])

  const searchableFields = [
    ...(hasDocID ? [{ name: '_docID', typeName: 'ID' }] : []),
    // For views use query-type fields; for collections use mutation input fields
    ...(viewMeta ? viewFields : formFields.filter(f => !relationFields.has(f.name) && ![...relationFields].some(r => f.name === `${r}_id`))),
    // Single relation fields only: search by the related doc's _docID
    // List (many) relations are excluded — filter syntax is unverified for list types
    ...(viewMeta ? [] : [...singleRelationFields].map(name => ({ name, typeName: 'ID' }))),
  ]

  const searchFieldType = searchableFields.find(f => f.name === searchField)?.typeName ?? 'String'
  const availableOps = OPERATORS_BY_TYPE[searchFieldType] ?? OPERATORS_BY_TYPE.String
  const effectiveOp = searchOp || availableOps[0]

  // Phase 1: schemaFields=null → fetch everything (let the API return the full field list).
  // Phase 2: schemaFields known → only request visible fields + valid system fields.
  // For views, Phase 1 derives fields from the GQL schema to exclude _docID, which
  // DefraDB's introspection includes but the runtime resolver rejects on non-materialized views.
  const fetchFields = useMemo(() => {
    if (!schemaFields) {
      if (viewMeta && gqlSchema) {
        const queryType = gqlSchema.getQueryType()
        const collField = queryType?.getFields()[collection]
        if (collField) {
          const collType = getNamedType(collField.type)
          if ('getFields' in collType) {
            const SKIP = new Set(['AVG', 'COUNT', 'MAX', 'MIN', 'SUM', 'SIMILARITY', 'GROUP'])
            const typeFields = (collType as { getFields(): Record<string, { type: GraphQLOutputType }> }).getFields()
            const fields = Object.entries(typeFields)
              .filter(([name, field]) => {
                if (name.startsWith('_') || SKIP.has(name)) return false
                // Exclude object types — they need sub-selection and aren't scalar view outputs
                return !('getFields' in getNamedType(field.type))
              })
              .map(([name]) => name)
            if (fields.length > 0) return fields
          }
        }
      }
      return undefined
    }
    const systemFields = ['_docID', '_deleted'].filter(f => schemaFields.includes(f))
    return [...new Set([...systemFields, ...visibleFields])]
  }, [schemaFields, visibleFields, viewMeta, gqlSchema, collection])

  const { data, isLoading, isError, error, refetch } = useDocuments(collection, page, search, searchField, searchFieldType, effectiveOp, pageSize, fetchFields, singleRelationFields)
  const { data: totalCount = 0 } = useDocumentCount(collection, search, searchField, searchFieldType, effectiveOp, relationFields)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [showNewDoc, setShowNewDoc]   = useState(false)
  const [toast, setToast]             = useState<string | null>(null)
  const [detailWidth, setDetailWidth] = useState(() => Math.round(window.innerWidth / 2))

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const rows      = (data?.rows   ?? []) as Record<string, unknown>[]
  const fields    = data?.fields ?? []
  const displayFields = fields.filter(f => f === '_docID' || !f.startsWith('_'))

  useEffect(() => {
    if (fields.length > 0) {
      setSchemaFields(fields)
      setVisibleFields(new Set(displayFields.slice(0, 7)))
      // If this type has no _docID (e.g. a View), reset the search field to the first available
      if (!fields.includes('_docID') && searchField === '_docID') {
        setSearchField(formFields[0]?.name ?? '')
      }
    }
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
    openDoc: (docID: string) => {
      if (hasDocID) {
        setSearchField('_docID')
        setFilter(docID)
        setPage(1)
      }
    },
  }))

  const offset = (page - 1) * pageSize

  const liveQuery = useMemo(() => {
    const fields = fetchFields ?? data?.fields
    if (!fields?.length) return null
    const filterArg = buildSearchFilter(search, searchField, searchFieldType, effectiveOp, relationFields)
    return buildDocumentsQuery(collection, fields, pageSize, offset, filterArg, singleRelationFields)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, searchField, searchFieldType, effectiveOp, collection, fetchFields, data?.fields, pageSize, offset, relationFields])

  return (
    <div className={styles.view}>
      <StatsRow
        collection={collection}
        count={totalCount}
        fieldCount={displayFields.length}
        isBranchable={collectionMeta?.is_branchable ?? false}
        isView={!!viewMeta}
        isMaterialized={viewMeta?.is_materialized}
        onViewSchema={onViewSchema}
        onRefreshView={viewMeta?.is_materialized ? () => refreshMut.mutate(collection, { onSuccess: () => refetch() }) : undefined}
        refreshPending={refreshMut.isPending}
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
        relationFields={singleRelationFields}
        listRelationFields={listRelationFields}
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
              onNewDoc={() => setShowNewDoc(true)}
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
            key={String(selected._docID ?? selectedIdx)}
            doc={selected as Record<string, unknown>}
            fields={displayFields}
            collection={collection}
            formFields={formFields}
            relationFields={singleRelationFields}
            listRelationFields={listRelationFields}
            viewNestedFields={viewNestedFields}
            hasDocID={hasDocID}
            onClose={() => setSelectedIdx(null)}
            onUpdate={(docID, values, original) => updateMut.mutateAsync({ docID, values, typeMap, original })}
            onDelete={async (docID) => {
              await deleteMut.mutateAsync(docID)
              setSelectedIdx(null)
            }}
            updatePending={updateMut.isPending}
            deletePending={deleteMut.isPending}
            onOpenInQueryRunner={onOpenInQueryRunner}
            panelWidth={detailWidth}
            onPanelWidthChange={setDetailWidth}
          />
        )}
      </div>  {/* split */}

      {showNewDoc && (
        <NewDocModal
          collection={collection}
          formFields={formFields}
          typeMap={typeMap}
          isPending={createMut.isPending}
          error={createMut.error as Error | null}
          onClose={() => { setShowNewDoc(false); createMut.reset() }}
          onSubmit={async (values) => {
            await createMut.mutateAsync({ values, typeMap })
            setShowNewDoc(false)
            setToast('Document created')
            setTimeout(() => setToast(null), 2500)
          }}
        />
      )}
      {toast && (
        <div className={styles.toast}>
          <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
            <circle cx={7} cy={7} r={6} fill="var(--green)" opacity={0.2}/>
            <circle cx={7} cy={7} r={6} stroke="var(--green)" strokeWidth={1.2}/>
            <path d="M4.5 7.2l1.8 1.8 3.2-3.6" stroke="var(--green-btn)" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {toast}
        </div>
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
        <ChevronDown
          size={10}
          className={`${styles.queryPreviewChevron} ${open ? styles.queryPreviewChevronOpen : ''}`}
          aria-hidden="true"
        />
        Query{hasFilter && <span className={styles.queryPreviewFilterDot} />}
      </button>
      {open && (
        <div className={styles.queryPreviewBody}>
          <div className={styles.queryPreviewActions}>
            {onOpenInQueryRunner && (
              <button className={styles.queryPreviewOpenBtn} onClick={() => onOpenInQueryRunner(query)}>
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

function StatsRow({ collection, count, fieldCount, isBranchable, isView, isMaterialized, onViewSchema, onRefreshView, refreshPending }: {
  collection: string; count: number; fieldCount: number; isBranchable?: boolean
  isView?: boolean; isMaterialized?: boolean
  onViewSchema?: (name: string) => void
  onRefreshView?: () => void
  refreshPending?: boolean
}) {
  return (
    <div className={styles.statsRow}>
      <div className={styles.statsMain}>
        <div className={styles.statsTitleRow}>
          <h1 className={styles.statsCollection}>{collection}</h1>
          {isBranchable && (
            <span className={styles.branchBadge} title="This collection tracks verifiable collection-level history">
              <GitBranch size={10} />
              branchable
            </span>
          )}
          {isView && (
            <span className={styles.branchBadge} title={isMaterialized ? 'Results are pre-computed and cached' : 'Results are computed at query time'}>
              {isMaterialized ? 'materialized view' : 'view'}
            </span>
          )}
        </div>
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
      <div style={{ display: 'flex', gap: 8 }}>
        {onRefreshView && (
          <button className={styles.refreshViewBtn} onClick={onRefreshView} disabled={refreshPending}>
            <RotateCw size={10} />
            {refreshPending ? 'Refreshing…' : 'Refresh view'}
          </button>
        )}
        {onViewSchema && (
          <button className={styles.viewSchemaBtn} onClick={() => onViewSchema(collection)}>
            View schema
            <ArrowRight size={10} />
          </button>
        )}
      </div>
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
        <ChevronDown size={8} className={styles.searchFieldCaret} aria-hidden="true" />
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

function Toolbar({ filter, searching, searchField, searchOp, availableOps, searchableFields, onFilterChange, onSearchFieldChange, onSearchOpChange, onRefresh, allFields, visibleFields, onToggleColumn, relationFields, listRelationFields }: {
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
  relationFields?: Set<string>
  listRelationFields?: Set<string>
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
  const showWildcardHint = !!searchField && wildcardOp && !filter.includes('%')

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
          <ChevronDown size={8} className={styles.searchFieldCaret} aria-hidden="true" />
        </div>
        <span className={styles.searchFieldSep} />
        <div className={styles.searchFieldWrap}>
          <select
            className={`${styles.searchFieldSelect} ${styles.searchOpSelect}`}
            value={searchField ? searchOp : ''}
            disabled={!searchField}
            onChange={e => onSearchOpChange(e.target.value)}
          >
            {!searchField && <option value="">op…</option>}
            {availableOps.map(o => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
          <ChevronDown size={8} className={styles.searchFieldCaret} aria-hidden="true" />
        </div>
        <span className={styles.searchFieldSep} />
        {searching ? (
          <span className={styles.toolbarSpinner} aria-hidden="true" />
        ) : (
          <Search size={11} style={{ flexShrink: 0, color: 'var(--gray-600)' }} />
        )}
        <div className={styles.searchInputWrap}>
          {showWildcardHint && <span className={styles.searchWildcard}>%</span>}
          <input
            type="text"
            placeholder={searchField ? `Search by ${searchField}…` : 'Choose a field first…'}
            value={filter}
            disabled={!searchField}
            onChange={e => onFilterChange(e.target.value)}
          />
          {showWildcardHint && <span className={styles.searchWildcard}>%</span>}
        </div>
        {filter && (
          <button className={styles.searchClear} onClick={() => onFilterChange('')} aria-label="Clear filter">
            Clear
          </button>
        )}
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
                {relationFields?.has(f) && (
                  <span className={styles.colsRelBadge}>rel</span>
                )}
              </label>
            ))}
            {listRelationFields && [...listRelationFields].map(f => (
              <div key={f} className={`${styles.colsItem} ${styles.colsItemDisabled}`} title="Many-relation columns are not shown in the table to avoid fetching large datasets">
                <input type="checkbox" disabled className={styles.colsCheckbox} />
                <span className={styles.colsLabel}>{f}</span>
                <span className={styles.colsRelBadge}>many</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <button className={`${styles.btnSm} ${styles.btnCyan}`} onClick={onRefresh} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><RotateCw size={11} /> Refresh</button>
    </div>
  )
}

// ── Document table ────────────────────────────────────────────────────────────

function DocumentTable({ rows, fields, selectedIdx, onSelect, onNewDoc }: {
  rows:        Record<string, unknown>[]
  fields:      string[]
  selectedIdx: number | null
  onSelect:    (i: number) => void
  onNewDoc?:   () => void
}) {
  if (rows.length === 0) {
    return (
      <div className={styles.emptyTable}>
        <p>No documents in this collection.</p>
        {onNewDoc && (
          <button className={styles.emptyTableCta} onClick={onNewDoc}>
            + Add first document
          </button>
        )}
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
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>
    if (obj._docID) return `→ ${String(obj._docID).slice(0, 18)}…`
    return JSON.stringify(value)
  }
  return String(value)
}

// ── List relation field (on-demand fetch) ────────────────────────────────────

function ListRelationField({ name, collection, docID }: { name: string; collection: string; docID: string }) {
  const { config } = useConfig()
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [docIDs, setDocIDs] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setState('loading')
    try {
      const query = `{ ${collection}(filter: { _docID: { _eq: ${JSON.stringify(docID)} } }) { ${name} { _docID } } }`
      const res = await executeGraphQL<Record<string, { [field: string]: { _docID: string }[] }[]>>(config, query)
      if (res.errors?.length) throw new Error(res.errors[0].message)
      const rows = (res.data?.[collection] ?? []) as Record<string, { _docID: string }[]>[]
      const ids = (rows[0]?.[name] ?? []).map((r: { _docID: string }) => r._docID)
      setDocIDs(ids)
      setState('done')
    } catch (e) {
      setErr((e as Error).message)
      setState('error')
    }
  }

  return (
    <div className={styles.fieldGroup}>
      <div className={styles.fieldKeyRow}>
        <p className={styles.fieldKey}>{name}</p>
        <span className={styles.colsRelBadge}>many</span>
      </div>
      <div className={styles.fieldVal}>
        {state === 'idle' && (
          <button className={styles.listRelLoadBtn} onClick={load}>Load related</button>
        )}
        {state === 'loading' && (
          <span style={{ color: 'var(--gray-600)' }}>Loading…</span>
        )}
        {state === 'error' && (
          <span style={{ color: '#FF5F57', fontSize: 11 }}>{err}</span>
        )}
        {state === 'done' && docIDs.length === 0 && (
          <span style={{ color: 'var(--gray-600)' }}>none</span>
        )}
        {state === 'done' && docIDs.length > 0 && (
          <div className={styles.listRelResults}>
            {docIDs.map(id => (
              <span key={id} className={styles.fieldValRef}>→ {id}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

type PanelMode = 'view' | 'history' | 'graph'

function DetailPanel({ doc, fields, collection, formFields, relationFields, listRelationFields, viewNestedFields, hasDocID, onClose, onUpdate, onDelete, updatePending, deletePending, onOpenInQueryRunner, panelWidth, onPanelWidthChange }: {
  doc:                Record<string, unknown>
  fields:             string[]
  collection:         string
  formFields:         FormField[]
  relationFields?:    Set<string>
  listRelationFields?: Set<string>
  viewNestedFields?:  { name: string; subFields: string[] }[]
  hasDocID?:          boolean
  onClose:            () => void
  onUpdate:           (docID: string, values: FormValues, original: FormValues) => Promise<unknown>
  onDelete:           (docID: string) => Promise<void>
  updatePending:      boolean
  deletePending:      boolean
  onOpenInQueryRunner?: (query: string) => void
  panelWidth:         number
  onPanelWidthChange: (w: number) => void
}) {
  const docID = String(doc._docID ?? '')
  const [mode, setMode]                 = useState<PanelMode>('view')
  const [editValues, setEditValues]       = useState<FormValues>({})
  const [isEditing, setIsEditing]         = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [mutErr, setMutErr]               = useState<string | null>(null)
  const [openCids, setOpenCids]           = useState<Set<string>>(new Set())
  const panelRef = useRef<HTMLElement>(null)

  function startPanelResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX     = e.clientX
    const startWidth = panelWidth
    const onMove = (ev: MouseEvent) => {
      const containerW = (panelRef.current?.offsetParent as HTMLElement)?.offsetWidth ?? window.innerWidth - 120
      onPanelWidthChange(Math.max(320, Math.min(containerW - 8, startWidth - (ev.clientX - startX))))
    }
    const onUp   = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function toggleCid(cid: string) {
    setOpenCids(prev => {
      const next = new Set(prev)
      next.has(cid) ? next.delete(cid) : next.add(cid)
      return next
    })
  }

  const { data: commits, isLoading: histLoading, error: histError, refetch: refetchCommits } = useDocumentCommits(docID)

  const commitRows = useMemo(() => {
    if (!commits) return null
    const byHeight = new Map<number, typeof commits>()
    for (const c of commits) {
      if (!byHeight.has(c.height)) byHeight.set(c.height, [])
      byHeight.get(c.height)!.push(c)
    }
    const compositeCidByHeight = new Map<number, string>()
    for (const [h, group] of byHeight) {
      const comp = group.find(c => c.fieldName === '_C')
      if (comp) compositeCidByHeight.set(h, comp.cid)
    }
    const maxHeight = Math.max(...byHeight.keys())
    return [...byHeight.entries()]
      .sort(([a], [b]) => b - a)
      .map(([height, group]) => {
        const composite    = group.find(c => c.fieldName === '_C')
        const cid          = composite?.cid ?? group[0]?.cid ?? ''
        const parentCID    = compositeCidByHeight.get(height - 1) ?? null
        const changedLinks = composite?.links.filter(l => l.fieldName && l.fieldName !== '_C') ?? []
        const shortCid     = cid.length > 20 ? `${cid.slice(0, 10)}…${cid.slice(-6)}` : cid
        const shortParent  = parentCID && parentCID.length > 16 ? `${parentCID.slice(0, 8)}…${parentCID.slice(-4)}` : parentCID
        const isHead   = height === maxHeight
        const isRoot   = height === 1
        const isMerge  = (byHeight.get(height - 1)?.filter(c => c.fieldName === '_C').length ?? 0) > 1
        return { height, cid, parentCID, changedLinks, shortCid, shortParent, isHead, isRoot, isMerge }
      })
  }, [commits])

  const { data: fullDoc, refetch: refetchDoc } = useDocumentById(collection, docID, fields, relationFields)
  const currentVersion = commits?.[0]?.height ?? null

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
    setIsEditing(true)
  }

  function cancelEdit() {
    setIsEditing(false)
    setMutErr(null)
  }

  async function saveEdit() {
    try {
      setMutErr(null)
      const jsonErr = validateValues(editValues, Object.fromEntries(editableFields.map(f => [f.name, f.typeName])))
      if (jsonErr) { setMutErr(jsonErr); return }
      const source = fullDoc ?? doc
      const original: FormValues = {}
      for (const f of editableFields) {
        const v = source[f.name]
        if (v !== null && v !== undefined) original[f.name] = String(v)
      }
      await onUpdate(docID, editValues, original)
      setIsEditing(false)
      refetchDoc()
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
    <aside ref={panelRef} className={styles.detail} style={{ width: panelWidth }}>
      <div className={styles.detailResizeHandle} onMouseDown={startPanelResize} />
      {/* Header */}
      <div className={styles.detailHeader}>
        <div className={styles.detailNameRow}>
          <p className={styles.detailName}>{collection}</p>
          {currentVersion !== null && (
            <span className={styles.detailVersion}>v{currentVersion}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {isEditing && mode === 'view' && (
            <>
              <button className={styles.btnSmEdit} onClick={cancelEdit}>Cancel</button>
              <button className={`${styles.btnSmEdit} ${styles.btnSmEditSave}`} onClick={saveEdit} disabled={updatePending}>
                {updatePending ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
          <button className={styles.panelCloseBtn} onClick={onClose} aria-label="Close panel">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Persistent action bar */}
      {onOpenInQueryRunner && (
        <div className={styles.detailSecondaryBar}>
          <button className={styles.detailSecondaryBtn} onClick={() => {
            const scalars = fields.map(f => relationFields?.has(f) ? `${f} { _docID }` : f).join(' ')
            const nested  = viewNestedFields?.map(f => `${f.name} { ${f.subFields.join(' ')} }`).join(' ') ?? ''
            const sel   = [scalars, nested].filter(Boolean).join(' ')
            const query = hasDocID && docID
              ? `{ ${collection}(filter: { _docID: { _eq: ${JSON.stringify(docID)} } }) { ${sel} } }`
              : `{ ${collection} { ${sel} } }`
            onOpenInQueryRunner(query)
          }}>
            <ArrowRight size={10} /> Open in Query Runner
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className={styles.detailTabs}>
        <button className={`${styles.detailTab} ${mode === 'view' ? styles.detailTabActive : ''}`}
          onClick={() => { setMode('view'); setIsEditing(false); setMutErr(null) }}>
          Fields
        </button>
        {hasDocID !== false && (
          <button className={`${styles.detailTab} ${mode === 'history' ? styles.detailTabActive : ''}`}
            onClick={() => { setMode('history'); setIsEditing(false) }}>
            History
            {currentVersion !== null && (
              <span className={`${styles.detailTabBadge} ${mode === 'history' ? styles.detailTabBadgeActive : ''}`}>{currentVersion}</span>
            )}
          </button>
        )}
        {hasDocID !== false && (
          <button className={`${styles.detailTab} ${mode === 'graph' ? styles.detailTabActive : ''}`}
            onClick={() => { setMode('graph'); setIsEditing(false) }}>
            <GitBranch size={11} /> Graph
          </button>
        )}
      </div>

      {mutErr && <div className={styles.detailError}>{mutErr}</div>}

      {/* Body */}
      <div className={mode === 'graph' ? styles.detailBodyGraph : styles.detailBody}>
        {mode === 'view' && (
          <>
            {/* Fields section header with Edit toggle */}
            <div className={styles.detailSectionLabelRow}>
              <p className={styles.detailSectionLabel}>Fields</p>
              {editableFields.length > 0 && !isEditing && hasDocID !== false && (
                <button className={styles.editToggleBtn} onClick={startEdit}>
                  <Pencil size={10} /> Edit
                </button>
              )}
            </div>

            {isEditing ? (
              editableFields.map(f => (
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
                      type={inputTypeFor(f.typeName)}
                      value={editValues[f.name] ?? ''}
                      onChange={e => setEditValues(p => ({ ...p, [f.name]: e.target.value }))}
                      placeholder={placeholderFor(f.typeName, f.required)}
                    />
                  )}
                </div>
              ))
            ) : (
              <>
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
                        <FieldValue value={viewDoc[f]} />
                      </p>
                    </div>
                  )
                })}
                {listRelationFields && [...listRelationFields].map(f => (
                  <ListRelationField key={f} name={f} collection={collection} docID={docID} />
                ))}
                {viewNestedFields && viewNestedFields.length > 0 && (
                  <>
                    <div className={styles.detailSectionLabelRow} style={{ marginTop: 8 }}>
                      <p className={styles.detailSectionLabel}>Nested fields</p>
                    </div>
                    {viewNestedFields.map(f => (
                      <div key={f.name} className={styles.fieldGroup}>
                        <div className={styles.fieldKeyRow}>
                          <p className={styles.fieldKey}>{f.name}</p>
                          <span className={styles.colsRelBadge}>nested</span>
                        </div>
                        <p className={styles.fieldVal} style={{ color: 'var(--gray-600)', fontSize: 11, fontStyle: 'italic' }}>
                          not loaded — use Open in Query Runner
                        </p>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </>
        )}

        {mode === 'history' && (
          <>
            <div className={styles.detailSectionLabelRow}>
              <p className={styles.detailSectionLabel} style={{ color: 'var(--gray-600)', fontSize: 11 }}>
                {docID.slice(0, 20)}…
              </p>
              <button className={styles.histRefreshBtn} onClick={() => refetchCommits()} disabled={histLoading} title="Refresh">
                <RotateCw size={11} />
              </button>
            </div>
            {histLoading && <p className={styles.histEmpty}>Loading…</p>}
            {histError && <p className={styles.histEmpty} style={{ color: '#FF5F57' }}>{(histError as Error).message}</p>}
            {!histLoading && !histError && commits?.length === 0 && (
              <p className={styles.histEmpty}>No commits found.</p>
            )}
            {commitRows?.map(({ height, cid, parentCID, changedLinks, shortCid, shortParent, isHead, isRoot, isMerge }) => {
              const isOpen = openCids.has(cid)
              return (
                <div key={height} className={`${styles.histVersion} ${isOpen ? styles.histVersionOpen : ''}`} onClick={() => toggleCid(cid)}>
                  <div className={styles.histVersionHead}>
                    <span className={styles.histHeight}>v{height}</span>
                    {isHead  && <span className={styles.tagHead}>head</span>}
                    {isMerge && <span className={styles.tagMerge}>merge</span>}
                    {isRoot  && <span className={styles.tagRoot}>root</span>}
                    <div className={styles.histCidRow}>
                      <span className={styles.histCid} title={cid}>{shortCid}</span>
                      <span onClick={e => e.stopPropagation()}>
                        <HistCopyButton text={cid} />
                      </span>
                    </div>
                    {shortParent && (
                      <span className={styles.histParent} title={parentCID ?? ''}>← {shortParent}</span>
                    )}
                    <ChevronDown size={12} className={`${styles.histChevron} ${isOpen ? styles.histChevronOpen : ''}`} />
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
            })}
          </>
        )}

        {mode === 'graph' && (
          <CommitGraph docID={docID} collection={collection} onOpenInQueryRunner={onOpenInQueryRunner} />
        )}
      </div>

      {/* Footer actions — only shown in fields view for documents with a docID */}
      {mode === 'view' && hasDocID !== false && <div className={styles.detailActions}>
        {!deleteConfirm ? (
          <button
            className={`${styles.btnSmAction} ${styles.btnSmActionDanger}`}
            onClick={() => setDeleteConfirm(true)}
          >
            Delete
          </button>
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
      </div>}
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

// ── Field input helpers ───────────────────────────────────────────────────────

function inputTypeFor(typeName: string): React.HTMLInputTypeAttribute {
  if (['Int', 'Float', 'Float32', 'Float64'].includes(typeName)) return 'number'
  return 'text'
}

function placeholderFor(typeName: string, required: boolean): string {
  if (typeName === 'JSON')     return required ? 'required — e.g. {"key": "value"}' : 'e.g. {"key": "value"}'
  if (typeName === 'Blob')     return required ? 'required — hex string e.g. ff0099' : 'hex string e.g. ff0099'
  if (typeName === 'DateTime') return required ? 'required — e.g. 2024-01-01 or 2024-01-01T12:00:00Z' : 'e.g. 2024-01-01 or 2024-01-01T12:00:00Z'
  return required ? 'required' : 'optional'
}


// ── New document modal ────────────────────────────────────────────────────────

function NewDocModal({ collection, formFields, typeMap, isPending, error, onClose, onSubmit }: {
  collection: string
  formFields: FormField[]
  typeMap:    TypeMap
  isPending:  boolean
  error:      Error | null
  onClose:    () => void
  onSubmit:   (values: FormValues) => Promise<void>
}) {
  const [values, setValues] = useState<FormValues>({})
  const [validationError, setValidationError] = useState<string | null>(null)

  // Fall back to a generic text field if schema hasn't loaded yet
  const fields: FormField[] = formFields.length > 0
    ? formFields
    : [{ name: '(schema loading…)', typeName: 'String', required: false }]

  function set(name: string, value: string) {
    setValues(p => ({ ...p, [name]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const err = validateValues(values, typeMap)
    if (err) { setValidationError(err); return }
    setValidationError(null)
    await onSubmit(values)
  }

  return (
    <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <p className={styles.modalTitle}>New {collection} document</p>
          <button className={styles.modalClose} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form onSubmit={handleSubmit} className={styles.modalForm}>
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
                    type={inputTypeFor(f.typeName)}
                    value={values[f.name] ?? ''}
                    onChange={e => set(f.name, e.target.value)}
                    placeholder={placeholderFor(f.typeName, f.required)}
                    required={f.required}
                  />
                )}
              </div>
            ))}

            {validationError && <p className={styles.modalError}>{validationError}</p>}
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
