import { useState, useCallback, useMemo, useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { EditorView, keymap, lineNumbers, drawSelection, placeholder } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'
import { graphql as graphqlExt, updateSchema } from 'cm6-graphql'
import { useViews, useCreateView, useDeleteView } from '../hooks/useViews'
import { useCollections } from '../hooks/useCollections'
import { useDocuments, PAGE_SIZE } from '../hooks/useDocuments'
import { useIntrospection } from '../hooks/useIntrospection'
import { isScalarField, executeGraphQL } from '../api/graphql'
import { useConfig } from '../context/ConfigContext'
import { useGraphQLSchema } from '../hooks/useGraphQLSchema'
import ResizeHandle from '../components/ResizeHandle'
import { useUIStore } from '../store/uiStore'
import { highlightRefCode } from '../lib/sdl'
import { sdlDirectiveAndTypeCompletionSource, sdlFieldSource } from '../lib/sdlComplete'
import { sdlFieldNameHighlighter } from '../lib/sdlFieldDecorator'
import type { ViewDescription } from '../api/types'
import type { IntrospectionType, IntrospectionField } from '../api/types'
import styles from './ViewsView.module.css'

// ── Shared CodeMirror config ─────────────────────────────────────────────────

const highlight = HighlightStyle.define([
  { tag: tags.keyword,           color: '#c792ea' }, // sdl-keyword: type, interface, enum…
  { tag: tags.definitionKeyword, color: '#c792ea' }, // query, mutation, subscription
  { tag: tags.modifier,          color: '#c792ea' }, // @directives
  { tag: tags.atom,              color: '#10CBFF' }, // Name nodes (type refs) — inherits keyword, override here
  { tag: tags.typeName,          color: '#10CBFF' }, // sdl-typename / sdl-typeref
  { tag: tags.propertyName,      color: '#a6e3a1' }, // sdl-field: field names
  { tag: tags.attributeName,     color: '#a6e3a1' }, // argument names
  { tag: tags.name,              color: '#cdd6f4' }, // fallback identifiers
  { tag: tags.string,            color: '#39e265' }, // sdl-string
  { tag: tags.number,            color: '#ffcb6b' }, // sdl-scalar-like
  { tag: tags.bool,              color: '#ffcb6b' },
  { tag: tags.comment,           color: '#6c7086', fontStyle: 'italic' },
  { tag: tags.punctuation,       color: '#6c7086' },
  { tag: tags.bracket,           color: '#6c7086' },
  { tag: tags.operator,          color: '#6c7086' },
])

const editorTheme = EditorView.theme({
  '&':                       { height: '100%', fontSize: '12px', fontFamily: "'CommitMono', monospace" },
  '.cm-content':             { padding: '14px 16px', lineHeight: '1.75', caretColor: '#10CBFF' },
  '.cm-cursor':              { borderLeftColor: '#10CBFF', borderLeftWidth: '2px' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#10CBFF' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(16,203,255,0.15) !important' },
  '.cm-scroller':            { overflow: 'auto', height: '100%' },
  '.cm-gutters':             { background: '#0d0d0d', border: 'none', paddingRight: '4px' },
  '.cm-lineNumbers .cm-gutterElement': { color: '#3f4359', fontSize: '11px', minWidth: '32px', paddingRight: '10px' },
  '.cm-tooltip':             { background: '#1a1a2e', border: '1px solid #2a2a3e', borderRadius: '6px', color: '#cdd6f4' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: "'CommitMono', monospace", fontSize: '12px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'rgba(16,203,255,0.15)', color: '#10CBFF' },
  '.cm-completionLabel':     { color: '#cdd6f4' },
  '.cm-completionDetail':    { color: '#6c7086', fontStyle: 'italic', marginLeft: '8px' },
  '.cm-completionMatchedText': { color: '#10CBFF', fontWeight: '600', textDecoration: 'none' },
})

function makeEditor(container: HTMLElement, doc: string, ph: string, onChange: (v: string) => void, extra: import('@codemirror/state').Extension[] = []) {
  return new EditorView({
    parent: container,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(),
        lineNumbers(),
        closeBrackets(),
        syntaxHighlighting(highlight),
        ...sdlFieldNameHighlighter(),
        editorTheme,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        placeholder(ph),
        EditorView.updateListener.of(u => { if (u.docChanged) onChange(u.state.doc.toString()) }),
        EditorView.theme({ '&': { background: 'transparent' } }),
        ...extra,
      ],
    }),
  })
}

// ── SDL completion (shared logic from lib/sdlComplete) ───────────────────────

// ── Reference helpers ─────────────────────────────────────────────────────────

function ScalarChip({ name }: { name: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={`${styles.refChip} ${copied ? styles.refChipCopied : ''}`}
      onClick={() => navigator.clipboard.writeText(name).then(() => {
        setCopied(true); setTimeout(() => setCopied(false), 1000)
      })}
      title={`Copy "${name}"`}
    >
      {copied ? '✓' : name}
    </button>
  )
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }, [text])
  return (
    <button className={styles.copyBtn} onClick={copy} title="Copy">
      {copied ? '✓' : 'copy'}
    </button>
  )
}

function RefCode({ children }: { children: string }) {
  return (
    <div className={styles.refCodeWrap}>
      <code
        className={styles.refCode}
        dangerouslySetInnerHTML={{ __html: highlightRefCode(children) }}
      />
      <CopyBtn text={children} />
    </div>
  )
}

// ── Create view form ─────────────────────────────────────────────────────────

const SDL_PLACEHOLDER = `type MyView {
  fieldOne: String
  fieldTwo: Int
}`

const QUERY_PLACEHOLDER = `{
  CollectionName {
    fieldOne
    fieldTwo
  }
}`

function stripBraces(q: string): string {
  const trimmed = q.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

const MIN_GUIDE   = 280
const MAX_GUIDE   = 600
const MIN_SDL_H   = 80
const DEFAULT_SDL_H = 220

export function CreateViewForm({ onDone }: { onDone: () => void }) {
  const viewDraftSdl       = useUIStore(s => s.viewDraftSdl)
  const setViewDraftSdl    = useUIStore(s => s.setViewDraftSdl)
  const viewDraftQuery     = useUIStore(s => s.viewDraftQuery)
  const setViewDraftQuery  = useUIStore(s => s.setViewDraftQuery)
  const viewGuideWidth     = useUIStore(s => s.viewGuideWidth)
  const setViewGuideWidth  = useUIStore(s => s.setViewGuideWidth)

  const [sdl, setSdlRaw]        = useState(viewDraftSdl)
  const [query, setQueryRaw]    = useState(viewDraftQuery)
  const setSdl   = useCallback((v: string) => { setSdlRaw(v);   setViewDraftSdl(v)   }, [setViewDraftSdl])
  const setQuery = useCallback((v: string) => { setQueryRaw(v); setViewDraftQuery(v) }, [setViewDraftQuery])
  const [error, setError]       = useState<string | null>(null)
  const [result, setResult]     = useState<ViewDescription[] | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testError, setTestError]   = useState<string | null>(null)
  const [testing, setTesting]       = useState(false)
  const [sdlHeight, setSdlHeight]   = useState(DEFAULT_SDL_H)
  const sdlRef         = useRef<HTMLDivElement>(null)
  const queryRef       = useRef<HTMLDivElement>(null)
  const sdlViewRef     = useRef<EditorView | null>(null)
  const qryViewRef     = useRef<EditorView | null>(null)
  const sdlFieldsRef   = useRef<{ name: string; typeName: string }[]>([])
  const sdlTypeNamesRef = useRef<string[]>([])

  const { mutateAsync, isPending } = useCreateView()
  const { config } = useConfig()
  const { data: collections } = useCollections()
  const { data: introspection } = useIntrospection()
  const schema = useGraphQLSchema()

  // Keep refs up-to-date so closures in effects always read current values
  const schemaRef = useRef(schema)
  schemaRef.current = schema
  const viewGuideWidthRef = useRef(viewGuideWidth)
  viewGuideWidthRef.current = viewGuideWidth

  const onResizeGuide = useCallback((delta: number) => {
    setViewGuideWidth(Math.max(MIN_GUIDE, Math.min(MAX_GUIDE, viewGuideWidthRef.current - delta)))
  }, [setViewGuideWidth])

  const onResizeEditors = useCallback((delta: number) => {
    setSdlHeight(prev => Math.max(MIN_SDL_H, prev + delta))
  }, [])

  // Populate type name list from introspection for SDL completions
  useEffect(() => {
    if (!introspection) return
    const HIDDEN = new Set(['Boolean','Float','ID','Int','String','__Directive','__DirectiveLocation',
      '__EnumValue','__Field','__InputValue','__Schema','__Type',
      'ExplainableMutation','ExplainableQuery','Mutation','Query','Subscription'])
    sdlTypeNamesRef.current = introspection.__schema.types
      .filter((t: IntrospectionType) => !HIDDEN.has(t.name) && !t.name.startsWith('_') && t.kind === 'OBJECT')
      .map((t: IntrospectionType) => t.name)
  }, [introspection])

  useEffect(() => {
    if (!sdlRef.current || !queryRef.current) return
    const sv = makeEditor(sdlRef.current, sdl, SDL_PLACEHOLDER, setSdl, [
      graphqlExt(),
      autocompletion({ override: [
        sdlDirectiveAndTypeCompletionSource(() => sdlTypeNamesRef.current),
        sdlFieldSource(() => sdlFieldsRef.current),
      ]}),
    ])
    const qv = makeEditor(queryRef.current, query, QUERY_PLACEHOLDER, setQuery, [
      graphqlExt(schemaRef.current ?? undefined),
    ])
    sdlViewRef.current = sv
    qryViewRef.current = qv
    return () => { sv.destroy(); qv.destroy() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Push updated schema into the query editor when it loads/changes
  useEffect(() => {
    if (qryViewRef.current && schema) updateSchema(qryViewRef.current, schema)
  }, [schema])

  function fillFromCollection(name: string) {
    const sdlText   = `type ${name}View {\n  \n}`
    const queryText = `{\n  ${name} {\n    \n  }\n}`
    function replaceDoc(view: EditorView, text: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    }
    if (sdlViewRef.current)  replaceDoc(sdlViewRef.current,  sdlText)
    if (qryViewRef.current)  replaceDoc(qryViewRef.current,  queryText)
    setSdl(sdlText)
    setQuery(queryText)

    // Populate SDL field completions from introspection
    const type = introspection?.__schema.types.find(
      (t: IntrospectionType) => t.name === name && t.kind === 'OBJECT'
    )
    sdlFieldsRef.current = (type?.fields ?? [])
      .filter((f: { name: string }) => !f.name.startsWith('_'))
      .map((f: IntrospectionField) => {
        let t: { name?: string | null; ofType?: { name?: string | null } | null } = f.type
        while (t.ofType) t = t.ofType
        return { name: f.name, typeName: t.name ?? 'String' }
      })
  }

  async function runTest() {
    const q = query.trim()
    if (!q) return
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    try {
      const bare = stripBraces(q)
      const res = await executeGraphQL(config, `{ ${bare} }`)
      if (res.errors?.length) {
        setTestError(res.errors.map(e => e.message).join('\n'))
      } else {
        setTestResult(JSON.stringify(res.data, null, 2))
      }
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  async function submit() {
    setError(null)
    setResult(null)
    if (!sdl.trim())   { setError('SDL is required'); return }
    if (!query.trim()) { setError('Query is required'); return }
    try {
      const views = await mutateAsync({ query: stripBraces(query), sdl: sdl.trim() })
      setResult(views)
      setViewDraftSdl('')
      setViewDraftQuery('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const viewName = sdl.match(/type\s+(\w+)/)?.[1] ?? null

  return (
    <div className={styles.formRoot}>
      {/* Toolbar */}
      <div className={styles.formToolbar}>
        <button className={styles.backBtn} onClick={onDone}>
          ← Schema
        </button>
        <span className={styles.backSep} />
        <span className={styles.formTitle}>New view</span>
        <span className={styles.formHint}>Define a virtual collection from a GraphQL query</span>
        {collections && collections.length > 0 && (
          <>
            <span className={styles.formHintSep}>·</span>
            <span className={styles.templateLabel}>Template from</span>
            <select
              className={styles.templateSelect}
              defaultValue=""
              onChange={e => { if (e.target.value) fillFromCollection(e.target.value) }}
            >
              <option value="" disabled>Select a collection…</option>
              {collections.map(c => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </>
        )}
        <div className={styles.formActions}>
          <button className={styles.btnPrimary} onClick={result ? onDone : submit} disabled={isPending}>
            {result ? 'Done' : isPending ? 'Creating…' : 'Create view'}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className={styles.formBody}>
        <div className={styles.createEditors}>
          <div className={styles.editorSection} style={{ flex: `0 0 ${sdlHeight}px` }}>
            <div className={styles.editorLabel}>
              Output type (SDL)
              {viewName && <span className={styles.editorLabelName}>{viewName}</span>}
            </div>
            <div className={styles.editorBox} ref={sdlRef} />
          </div>
          <ResizeHandle direction="vertical" onResize={onResizeEditors} />
          <div className={styles.editorSection} style={{ flex: 1 }}>
            <div className={styles.editorLabel}>
              Underlying query
              <button className={styles.runQueryBtn} onClick={runTest} disabled={testing || !query.trim()}>
                {testing ? 'Running…' : '▶ Run'}
              </button>
            </div>
            <div className={styles.editorBox} ref={queryRef} style={{ flex: testResult || testError ? '0 0 50%' : 1 }} />
            {(testResult || testError) && (
              <div className={`${styles.testResultPane} ${testError ? styles.testResultError : ''}`}>
                <div className={styles.testResultHeader}>
                  <span>{testError ? 'Error' : 'Result'}</span>
                  <button className={styles.testResultClose} onClick={() => { setTestResult(null); setTestError(null) }}>✕</button>
                </div>
                <pre className={styles.testResultBody}>{testError ?? testResult}</pre>
              </div>
            )}
          </div>
        </div>

        <ResizeHandle direction="horizontal" onResize={onResizeGuide} />

        <div className={styles.formSidebar} style={{ width: viewGuideWidth }}>
          {result && (
            <div className={styles.resultCard}>
              <div className={styles.resultHeader}>
                <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
                  <circle cx={8} cy={8} r={7} fill="var(--green)" opacity={0.15}/>
                  <circle cx={8} cy={8} r={7} stroke="var(--green)" strokeWidth={1.3}/>
                  <path d="M5 8l2 2 4-4" stroke="var(--green)" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {result.length} view{result.length !== 1 ? 's' : ''} created
              </div>
              {result.map(v => (
                <div key={v.name} className={styles.resultItem}>
                  <span className={styles.resultName}>{v.name}</span>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className={styles.errorCard}>
              <div className={styles.errorHeader}>
                <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
                  <circle cx={7} cy={7} r={6} stroke="#FF5F57" strokeWidth={1.3}/>
                  <line x1={7} y1={4} x2={7} y2={7.5} stroke="#FF5F57" strokeWidth={1.5} strokeLinecap="round"/>
                  <circle cx={7} cy={10} r={0.8} fill="#FF5F57"/>
                </svg>
                Error
              </div>
              <p className={styles.errorMsg}>{error}</p>
            </div>
          )}

          <div className={styles.refCard}>
            <p className={styles.refTitle}>View reference</p>
            <div className={styles.refQuickLinks}>
              {([
                ['view-output-type', 'output type'],
                ['view-query',       'query shape'],
                ['view-caching',     'caching'],
              ] as [string, string][]).map(([id, label]) => (
                <button
                  key={id}
                  className={styles.refQuickLink}
                  onClick={() => {
                    const el = document.getElementById(id)
                    if (!el) return
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                >{label}</button>
              ))}
            </div>

            {/* ── Output type ───────────────────────── */}
            <p id="view-output-type" className={styles.refGroupLabel}>Output type (SDL)</p>

            <div id="view-scalars" className={styles.refSection}>
              <p className={styles.refSectionHead}>Scalar types</p>
              <p className={styles.refSectionDesc}>The SDL defines the shape of the view's output. Click to copy a type name. Fields not listed in the SDL are hidden from consumers.</p>
              <div className={styles.refChips}>
                {['String','Int','Float','Boolean','DateTime','ID','JSON','Blob'].map(t => (
                  <ScalarChip key={t} name={t} />
                ))}
              </div>
            </div>

            <div className={styles.refSection}>
              <p className={styles.refSectionHead}>Required &amp; arrays</p>
              <p className={styles.refSectionDesc}><code>!</code> marks a field non-null; <code>[]</code> makes it a list. The type shape in the SDL must be compatible with what the underlying query actually returns.</p>
              <RefCode>{'type PostView {\n  title: String!     # required\n  tags: [String]     # list\n}'}</RefCode>
            </div>

            {/* ── Query shape ───────────────────────── */}
            <p id="view-query" className={styles.refGroupLabel}>Query shape</p>

            <div id="view-select" className={styles.refSection}>
              <p className={styles.refSectionHead}>Select fields</p>
              <p className={styles.refSectionDesc}>Only the fields you list are fetched. Omitting fields is the primary way to hide sensitive data or reduce payload size.</p>
              <RefCode>{'User {\n  name\n  email\n}'}</RefCode>
            </div>

            <div id="view-rename" className={styles.refSection}>
              <p className={styles.refSectionHead}>Rename (alias)</p>
              <p className={styles.refSectionDesc}>Map a source field to a different output name. The SDL type must use the aliased name, not the original.</p>
              <RefCode>{'User {\n  fullName: name\n  contact: email\n}'}</RefCode>
            </div>

            <div id="view-filter" className={styles.refSection}>
              <p className={styles.refSectionHead}>Filter</p>
              <p className={styles.refSectionDesc}>Narrow to a subset of source rows. Filters run at query time — use <code>@materialized(if: true)</code> if you want the result pre-computed.</p>
              <RefCode>{'User(filter: { active: { _eq: true } }) {\n  name\n}'}</RefCode>
            </div>

            <div id="view-order" className={styles.refSection}>
              <p className={styles.refSectionHead}>Limit &amp; order</p>
              <p className={styles.refSectionDesc}>Cap the number of rows returned and control sort order. <code>limit</code> applies after filtering.</p>
              <RefCode>{'Post(\n  limit: 50\n  order: { createdAt: DESC }\n) {\n  title\n  createdAt\n}'}</RefCode>
            </div>

            <div id="view-related" className={styles.refSection}>
              <p className={styles.refSectionHead}>Traverse relations</p>
              <p className={styles.refSectionDesc}>Nest a related collection to include linked documents inline. The related type must already exist as a collection in your schema.</p>
              <RefCode>{'Post {\n  title\n  author {\n    name\n    email\n  }\n}'}</RefCode>
            </div>

            {/* ── Caching ───────────────────────────── */}
            <p id="view-caching" className={styles.refGroupLabel}>Caching</p>

            <div id="view-mat" className={styles.refSection}>
              <p className={styles.refSectionHead}>@materialized</p>
              <p className={styles.refSectionDesc}><code>if: true</code> — result is stored on write and returned directly on read (fast, but reflects data at write time). <code>if: false</code> — query re-runs on every request (always fresh, no storage cost).</p>
              <RefCode>{'# Cached — fast reads\ntype ActiveUsersView @materialized(if: true) {\n  name: String\n}\n\n# Always fresh — no cache\ntype StatsView @materialized(if: false) {\n  count: Int\n}'}</RefCode>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Data pane ────────────────────────────────────────────────────────────────

function DataPane({ viewName }: { viewName: string }) {
  const [page, setPage] = useState(1)
  const { data, isLoading, isError } = useDocuments(viewName, page)

  const rows   = data?.rows ?? []
  const fields = (data?.fields ?? []).filter(f => !f.startsWith('_deleted'))

  // totalPages intentionally unused — pagination uses row count heuristic inline

  if (isLoading) return <div className={styles.paneLoading}><div className={styles.skRow} /><div className={styles.skRow} /><div className={styles.skRow} /></div>
  if (isError)   return <div className={styles.paneEmpty}>Could not load view data.</div>
  if (!rows.length && page === 1) return <div className={styles.paneEmpty}>No documents in this view.</div>

  return (
    <div className={styles.dataPane}>
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>{fields.map(f => <th key={f}>{f}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={(row as Record<string, unknown>)._docID as string ?? i}>
                {fields.map(f => {
                  const val = (row as Record<string, unknown>)[f]
                  return (
                    <td key={f} className={styles.dataCell}>
                      {val === null || val === undefined ? <span className={styles.nullVal}>null</span> : String(val)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.dataPager}>
        <button className={styles.pagerBtn} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>← Prev</button>
        <span className={styles.pagerPage}>Page {page}</span>
        <button className={styles.pagerBtn} onClick={() => setPage(p => p + 1)} disabled={rows.length < PAGE_SIZE}>Next →</button>
      </div>
    </div>
  )
}

// ── Definition pane ──────────────────────────────────────────────────────────

function DefinitionPane({ view }: { view: ViewDescription }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    const text = [view.query, view.sdl].filter(Boolean).join('\n\n')
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }

  return (
    <div className={styles.defPane}>
      <div className={styles.defSection}>
        <div className={styles.defLabelRow}>
          <span className={styles.defLabel}>Query</span>
          <button className={styles.defCopy} onClick={copy}>{copied ? '✓ Copied' : 'Copy all'}</button>
        </div>
        <pre className={styles.defCode}>{view.query}</pre>
      </div>
      {view.sdl && (
        <div className={styles.defSection}>
          <span className={styles.defLabel}>Output SDL</span>
          <pre className={styles.defCode}>{view.sdl}</pre>
        </div>
      )}
    </div>
  )
}

// ── View panel ───────────────────────────────────────────────────────────────

const HIDDEN_TYPES = new Set([
  'Boolean', 'Float', 'ID', 'Int', 'String', '__Directive', '__DirectiveLocation',
  '__EnumValue', '__Field', '__InputValue', '__Schema', '__Type',
  'ExplainableMutation', 'ExplainableQuery', 'Mutation', 'Query', 'Subscription',
])

function ViewPanel({ view, onDeleted }: { view: ViewDescription; onDeleted: () => void }) {
  const [tab, setTab] = useState<'data' | 'definition'>('data')
  const { mutateAsync: deleteView, isPending } = useDeleteView()
  const { data: schema } = useIntrospection()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const fieldCount = useMemo(() => {
    if (!schema) return null
    const type = schema.__schema.types.find(t => t.name === view.name && !HIDDEN_TYPES.has(t.name))
    return type?.fields?.filter(f => isScalarField(f.type)).length ?? null
  }, [schema, view.name])

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    await deleteView(view.name)
    onDeleted()
  }

  return (
    <div className={styles.viewPanel}>
      <div className={styles.viewHeader}>
        <div className={styles.viewHeaderLeft}>
          <h2 className={styles.viewName}>{view.name}</h2>
          {fieldCount !== null && <span className={styles.viewMeta}>{fieldCount} fields</span>}
          <span className={styles.viewBadge}>view</span>
        </div>
        <button
          className={confirmDelete ? styles.btnDeleteConfirm : styles.btnDelete}
          onClick={handleDelete}
          disabled={isPending}
        >
          {isPending ? 'Deleting…' : confirmDelete ? 'Confirm delete' : 'Delete'}
        </button>
      </div>

      <div className={styles.viewTabBar}>
        <button className={`${styles.viewTab} ${tab === 'data' ? styles.viewTabActive : ''}`} onClick={() => setTab('data')}>Data</button>
        <button className={`${styles.viewTab} ${tab === 'definition' ? styles.viewTabActive : ''}`} onClick={() => setTab('definition')}>Definition</button>
      </div>

      {tab === 'data'       && <DataPane viewName={view.name} />}
      {tab === 'definition' && <DefinitionPane view={view} />}
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={styles.emptyState}>
      <p className={styles.emptyTitle}>No views yet</p>
      <p className={styles.emptyBody}>
        Views are virtual collections defined by a GraphQL query. They let you
        project, aggregate, or join data from existing collections without
        storing a separate copy.
      </p>
      <button className={styles.btnCreate} onClick={onCreate}>+ Create your first view</button>
    </div>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────────

const MIN_SIDEBAR  = 160
const MAX_SIDEBAR  = 400

export interface ViewsViewHandle {
  openCreate:  () => void
  selectView:  (name: string) => void
}

const ViewsView = forwardRef<ViewsViewHandle>(function ViewsView(_, ref) {
  const { data: views = [], isLoading } = useViews()
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [showCreate, setShowCreate]     = useState(false)
  const sidebarWidth    = useUIStore(s => s.viewsSidebarWidth)
  const setSidebarWidth = useUIStore(s => s.setViewsSidebarWidth)

  useImperativeHandle(ref, () => ({
    openCreate: () => setShowCreate(true),
    selectView: (name: string) => { setShowCreate(false); setSelectedName(name) },
  }))

  const onResizeSidebar = useCallback((delta: number) => {
    setSidebarWidth(Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, sidebarWidth + delta)))
  }, [setSidebarWidth, sidebarWidth])

  const selected = views.find(v => v.name === selectedName) ?? null

  if (showCreate) {
    return (
      <div className={styles.shell}>
        <CreateViewForm onDone={() => { setShowCreate(false) }} />
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className={styles.shell}>
        <div className={styles.sidebar}>
          {[...Array(4)].map((_, i) => (
            <div key={i} className={styles.skeleton} style={{ width: `${55 + i * 10}%` }} />
          ))}
        </div>
        <div className={styles.main} />
      </div>
    )
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar} style={{ width: sidebarWidth }}>
        <button className={styles.createBtn} onClick={() => setShowCreate(true)}>+ New view</button>
        {views.length > 0 && (
          <>
            <p className={styles.groupLabel}>Views</p>
            {views.map(v => (
              <button
                key={v.name}
                className={`${styles.viewItem} ${selectedName === v.name ? styles.viewItemActive : ''}`}
                onClick={() => setSelectedName(v.name)}
              >
                <span className={styles.viewItemName}>{v.name}</span>
                <span className={styles.viewItemBadge}>view</span>
              </button>
            ))}
          </>
        )}
      </aside>

      <ResizeHandle direction="horizontal" onResize={onResizeSidebar} />

      <div className={styles.main}>
        {selected ? (
          <ViewPanel
            key={selected.name}
            view={selected}
            onDeleted={() => setSelectedName(null)}
          />
        ) : (
          <EmptyState onCreate={() => setShowCreate(true)} />
        )}
      </div>
    </div>
  )
})

export default ViewsView
