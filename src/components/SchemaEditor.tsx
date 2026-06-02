import { useEffect, useRef, useState, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { closeBrackets } from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'
import { graphql as graphqlExt } from 'cm6-graphql'
import { useConfig } from '../context/ConfigContext'
import { useIntrospection } from '../hooks/useIntrospection'
import { useCollections } from '../hooks/useCollections'
import { useViews } from '../hooks/useViews'
import { createCollection, patchCollection, sdlToCollectionPatchOps } from '../api/graphql'
import { queryKeys } from '../lib/queryKeys'
import type { CollectionDescription } from '../api/types'
import type { IntrospectionType } from '../api/types'
import ResizeHandle from './ResizeHandle'
import { useUIStore } from '../store/uiStore'
import { highlightRefCode, highlightJson } from '../lib/sdl'
import { makeSdlCompletion, DIRECTIVES_CREATE, DIRECTIVES_PATCH } from '../lib/sdlComplete'
import { sdlFieldNameHighlighter } from '../lib/sdlFieldDecorator'
import styles from './SchemaEditor.module.css'

// ── Highlight + theme (reused from GraphQLEditor) ─────────────────────────────

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
  '&': { height: '100%', fontSize: '13px', fontFamily: "'CommitMono', 'JetBrains Mono', monospace" },
  '.cm-content':     { padding: '20px', lineHeight: '1.8', caretColor: '#10CBFF' },
  '.cm-cursor':      { borderLeftColor: '#10CBFF', borderLeftWidth: '2px' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#10CBFF' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(16,203,255,0.15) !important' },
  '.cm-scroller':    { overflow: 'auto', height: '100%' },
  '.cm-gutters':     { background: '#0d0d0d', border: 'none', paddingRight: '4px' },
  '.cm-lineNumbers .cm-gutterElement': { color: '#3f4359', fontSize: '11px', minWidth: '36px', paddingRight: '12px' },
  '.cm-tooltip': {
    background: '#1a1a2e',
    border: '1px solid var(--dark-border)',
    borderRadius: '6px',
    color: 'var(--muted)',
    fontSize: '12px',
    fontFamily: "'CommitMono', monospace",
  },
  '.cm-diagnostic': {
    padding: '6px 10px',
    borderLeft: '3px solid #FF5F57',
    color: 'var(--muted)',
    background: '#1a1a2e',
  },
  '.cm-diagnostic-error': { borderLeftColor: '#FF5F57' },
  '.cm-diagnostic-warning': { borderLeftColor: '#e0a96d' },
})

const CREATE_TEMPLATE = `type TypeName {
  fieldOne: String
  fieldTwo: Int
  createdAt: DateTime
}
`

const PATCH_TEMPLATE = `type User {
  newField: String
}
`

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

function PatchCopyBtn({ json }: { json: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(json).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <button className={styles.copyBtn} onClick={copy}>{copied ? '✓' : 'copy'}</button>
  )
}

// ── SDL type completion ───────────────────────────────────────────────────────

const HIDDEN_INTROSPECTION = new Set([
  'Boolean','Float','ID','Int','String','__Directive','__DirectiveLocation',
  '__EnumValue','__Field','__InputValue','__Schema','__Type',
  'ExplainableMutation','ExplainableQuery','Mutation','Query','Subscription',
])


// ── SDL editor (CodeMirror) ───────────────────────────────────────────────────

function SDLEditor({ value, onChange, extra = [] }: {
  value: string
  onChange: (v: string) => void
  extra?: import('@codemirror/state').Extension[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef      = useRef<EditorView | null>(null)
  const onChangeRef  = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!containerRef.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        lineNumbers(),
        drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        graphqlExt(),
        syntaxHighlighting(highlight),
        ...sdlFieldNameHighlighter(),
        closeBrackets(),
        editorTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of(u => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
        ...extra,
      ],
    })
    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur !== value) view.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
  }, [value])

  return <div ref={containerRef} style={{ height: '100%' }} />
}

// ── Result display ────────────────────────────────────────────────────────────

function ResultCard({ collections, mode }: { collections: CollectionDescription[]; mode: 'create' | 'patch' }) {
  const label = mode === 'patch'
    ? `${collections.length} collection${collections.length !== 1 ? 's' : ''} patched`
    : `${collections.length} collection${collections.length !== 1 ? 's' : ''} created`
  return (
    <div className={styles.resultCard}>
      <div className={styles.resultHeader}>
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
          <circle cx={8} cy={8} r={7} fill="var(--green)" opacity={0.15}/>
          <circle cx={8} cy={8} r={7} stroke="var(--green)" strokeWidth={1.3}/>
          <path d="M5 8l2 2 4-4" stroke="var(--green)" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span>{label}</span>
      </div>
      {collections.map(c => (
        <div key={c.name} className={styles.resultItem}>
          <span className={styles.resultName}>{c.name}</span>
          <span className={styles.resultFields}>{(c.fields ?? []).filter(f => !f.name.startsWith('_')).length} fields</span>
          <span className={styles.resultVersion}>{c.version_id?.slice(0, 12)}…</span>
        </div>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  onDone?: () => void
  initialMode?: 'create' | 'patch'
}

const MIN_GUIDE  = 280
const MAX_GUIDE  = () => Math.round(window.innerWidth * 0.75)

export default function SchemaEditor({ onDone, initialMode = 'create' }: Props) {
  const { config }    = useConfig()
  const queryClient   = useQueryClient()
  const storeMode                  = useUIStore(s => s.schemaEditorMode)
  const schemaGuideWidth              = useUIStore(s => s.schemaGuideWidth)
  const setSchemaGuideWidth           = useUIStore(s => s.setSchemaGuideWidth)
  const schemaEditorPreviewHeight     = useUIStore(s => s.schemaEditorPreviewHeight)
  const setSchemaEditorPreviewHeight  = useUIStore(s => s.setSchemaEditorPreviewHeight)
  const schemaEditorDraftCreate    = useUIStore(s => s.schemaEditorDraftCreate)
  const setSchemaEditorDraftCreate = useUIStore(s => s.setSchemaEditorDraftCreate)
  const schemaEditorDraftPatch     = useUIStore(s => s.schemaEditorDraftPatch)
  const setSchemaEditorDraftPatch  = useUIStore(s => s.setSchemaEditorDraftPatch)
  const { data: introspection } = useIntrospection()
  const { data: collections }   = useCollections()
  const { data: views }         = useViews()

  // Honour initialMode on first mount; thereafter track store
  const [mode, setMode] = useState<'create' | 'patch'>(initialMode)
  const initialDraft = initialMode === 'patch'
    ? (schemaEditorDraftPatch  || PATCH_TEMPLATE)
    : (schemaEditorDraftCreate || CREATE_TEMPLATE)
  const [sdl, setSdlRaw] = useState(initialDraft)
  const setSdl = useCallback((v: string) => {
    setSdlRaw(v)
    if (mode === 'patch') setSchemaEditorDraftPatch(v)
    else setSchemaEditorDraftCreate(v)
  }, [mode, setSchemaEditorDraftCreate, setSchemaEditorDraftPatch])
  const [result, setResult] = useState<CollectionDescription[] | null>(null)

  // Live patch preview — derived from sdl whenever in patch mode
  const patchPreview = (() => {
    if (mode !== 'patch') return null
    try { return sdlToCollectionPatchOps(sdl) } catch { return null }
  })()


  // User-defined type names for SDL completion
  const typeNamesRef = useRef<string[]>([])
  useEffect(() => {
    if (!introspection) return
    const viewNames = new Set(views?.map(v => v.name) ?? [])
    typeNamesRef.current = introspection.__schema.types
      .filter((t: IntrospectionType) => !HIDDEN_INTROSPECTION.has(t.name) && !t.name.startsWith('_') && t.kind === 'OBJECT' && !viewNames.has(t.name))
      .map((t: IntrospectionType) => t.name)
  }, [introspection, views])

  // Stable completion extension — reads typeNamesRef and modeRef at completion time
  const modeRef = useRef(mode)
  modeRef.current = mode
  const typeCompletion = useRef(makeSdlCompletion(
    () => typeNamesRef.current,
    () => modeRef.current === 'patch' ? DIRECTIVES_PATCH : DIRECTIVES_CREATE,
  ))

  // Sync store → local when store changes externally (e.g. SchemaView opens patch)
  useEffect(() => {
    if (storeMode !== mode) {
      setMode(storeMode)
      setSdlRaw(storeMode === 'patch'
        ? (schemaEditorDraftPatch  || PATCH_TEMPLATE)
        : (schemaEditorDraftCreate || CREATE_TEMPLATE))
      setResult(null)
    }
  }, [storeMode]) // eslint-disable-line react-hooks/exhaustive-deps

const schemaGuideWidthRef = useRef(schemaGuideWidth)
  schemaGuideWidthRef.current = schemaGuideWidth
  const onResizeGuide = useCallback((delta: number) => {
    setSchemaGuideWidth(Math.max(MIN_GUIDE, Math.min(MAX_GUIDE(), schemaGuideWidthRef.current - delta)))
  }, [setSchemaGuideWidth])

  const previewHeightRef = useRef(schemaEditorPreviewHeight)
  previewHeightRef.current = schemaEditorPreviewHeight
  const onResizePreview = useCallback((delta: number) => {
    const maxH = Math.round(window.innerHeight * 0.75)
    setSchemaEditorPreviewHeight(Math.max(80, Math.min(maxH, previewHeightRef.current - delta)))
  }, [setSchemaEditorPreviewHeight])

  const { mutate, isPending, isError, error, reset } = useMutation({
    mutationFn: async () => {
      if (!sdl.trim()) throw new Error('SDL cannot be empty')
      const fn = mode === 'create' ? createCollection : patchCollection
      return fn(config, sdl)
    },
    onSuccess: data => {
      setResult(data)
      if (mode === 'patch') setSchemaEditorDraftPatch('')
      else setSchemaEditorDraftCreate('')
      queryClient.invalidateQueries({ queryKey: queryKeys.introspection(config.baseUrl) })
      queryClient.invalidateQueries({ queryKey: queryKeys.collections(config.baseUrl) })
    },
  })

  return (
    <div className={styles.root}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        {onDone && (
          <>
            <button className={styles.backBtn} onClick={onDone}>← Schema</button>
            <span className={styles.backSep} />
          </>
        )}
        <span className={styles.modeTitle}>
          {mode === 'create' ? 'New collection' : 'Patch collection'}
        </span>
        <span className={styles.toolbarHint}>
          {mode === 'create' ? 'Define a new collection with SDL' : 'Add fields to an existing collection'}
        </span>
        <div className={styles.toolbarActions}>
          {mode === 'patch' && collections && collections.length > 0 && (
            <select
              className={styles.collectionPicker}
              defaultValue=""
              onChange={e => {
                const name = e.target.value
                if (!name) return
                setSdl(`type ${name} {\n  newField: String\n}\n`)
                setResult(null)
              }}
            >
              <option value="" disabled>Pick collection…</option>
              {collections.map(c => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          )}
          <button
            className={styles.btnApply}
            onClick={() => { reset(); setResult(null); mutate() }}
            disabled={isPending}
          >
            {isPending ? 'Applying…' : mode === 'create' ? 'Create collection' : 'Patch collection'}
          </button>
        </div>
      </div>

      {/* Editor + sidebar */}
      <div className={styles.body}>
        <div className={styles.editorColumn}>
          <div className={styles.editorWrap}>
            <SDLEditor value={sdl} onChange={v => { setSdl(v); setResult(null) }} extra={[typeCompletion.current]} />
          </div>

          {patchPreview !== null && (
            <>
              <ResizeHandle direction="vertical" onResize={onResizePreview} />
              <div className={styles.patchPreviewPane} style={{ height: schemaEditorPreviewHeight }}>
                <div className={styles.patchPreviewPaneHeader}>
                  <span>JSON patch preview</span>
                  <PatchCopyBtn json={JSON.stringify(patchPreview, null, 2)} />
                </div>
                <pre
                  className={styles.patchPreviewPaneCode}
                  dangerouslySetInnerHTML={{ __html: highlightJson(JSON.stringify(patchPreview, null, 2)) }}
                />
              </div>
            </>
          )}
        </div>

        <ResizeHandle direction="horizontal" onResize={onResizeGuide} />

        <div className={styles.sidebar} style={{ width: schemaGuideWidth }}>
          {/* Result */}
          {result && <ResultCard collections={result} mode={mode} />}

          {/* Error */}
          {isError && (
            <div className={styles.errorCard}>
              <div className={styles.errorHeader}>
                <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
                  <circle cx={7} cy={7} r={6} stroke="#FF5F57" strokeWidth={1.3}/>
                  <line x1={7} y1={4} x2={7} y2={7.5} stroke="#FF5F57" strokeWidth={1.5} strokeLinecap="round"/>
                  <circle cx={7} cy={10} r={0.8} fill="#FF5F57"/>
                </svg>
                Error
              </div>
              <p className={styles.errorMsg}>{(error as Error).message}</p>
            </div>
          )}

          {/* SDL reference */}
          <div className={styles.refCard}>
            <p className={styles.refTitle}>{mode === 'patch' ? 'Patch reference' : 'SDL reference'}</p>
            <div className={styles.refQuickLinks}>
              {(mode === 'patch' ? [
                ['sdl-patch-add',    'add fields'],
                ['sdl-field-types',  'field types'],
                ['sdl-patch-frozen', "can't change"],
              ] : [
                ['sdl-field-types', 'field types'],
                ['sdl-indexing',    'indexing'],
                ['sdl-relations',   'relations'],
                ['sdl-crdt',        '@crdt'],
                ['sdl-collection',  'collection'],
              ] as [string, string][]).map(([id, label]) => (
                <button
                  key={id}
                  className={styles.refQuickLink}
                  onClick={() => {
                    const el = document.getElementById(id)
                    if (!el) return
                    el.closest('[class*="sidebar"]')?.scrollTo({ top: (el as HTMLElement).offsetTop - 12, behavior: 'smooth' })
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                >{label}</button>
              ))}
            </div>

            {mode === 'patch' && (
              <>
                {/* ── Adding fields ──────────────────────── */}
                <p id="sdl-patch-add" className={styles.refGroupLabel}>Adding fields</p>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>How it works</p>
                  <p className={styles.refSectionDesc}>Write the exact collection name, then list <em>only the new fields</em> you want to add. Existing fields are preserved — you do not need to repeat them. Each patch creates a new schema version.</p>
                  <RefCode>{'type User {\n  score: Int @crdt(type: pncounter)\n  email: String @index(unique: true)\n  tags: [String]\n}'}</RefCode>
                </div>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>Can't remove fields</p>
                  <p className={styles.refSectionDesc}>DefraDB does not support removing fields from an existing collection. Patches can only add new fields.</p>
                </div>
              </>
            )}

            {/* ── Field types ──────────────────────── */}
            <p id="sdl-field-types" className={styles.refGroupLabel}>{mode === 'patch' ? 'Field types (for new fields)' : 'Field types'}</p>

            <div className={styles.refSection}>
              <p className={styles.refSectionHead}>Scalars</p>
              <p className={styles.refSectionDesc}>Click to copy. <code>DateTime</code> is ISO-8601; <code>Blob</code> is base64 binary; <code>JSON</code> stores arbitrary structured data without a schema.</p>
              <div className={styles.refChips}>
                {['String', 'Int', 'Float', 'Float32', 'Float64', 'Boolean', 'DateTime', 'Blob', 'JSON', 'ID'].map(t => (
                  <ScalarChip key={t} name={t} />
                ))}
              </div>
            </div>

            <div id="sdl-required" className={styles.refSection}>
              <p className={styles.refSectionHead}>Required &amp; arrays</p>
              <p className={styles.refSectionDesc}>A trailing <code>!</code> means non-null — the write will be rejected if this field is missing. Wrap in <code>[]</code> for a list type.</p>
              <RefCode>{'name: String!     # required\ntags: [String]    # nullable array\ntags: [String!]!  # required, non-null items'}</RefCode>
            </div>

            <div id="sdl-float" className={styles.refSection}>
              <p className={styles.refSectionHead}>Float precision</p>
              <p className={styles.refSectionDesc}><code>Float</code> and <code>Float64</code> are 64-bit IEEE 754. Use <code>Float32</code> when storage size matters and full precision is not needed.</p>
              <RefCode>{'score: Float32   # 32-bit, ~7 decimal digits\nrating: Float64  # 64-bit, ~15 decimal digits'}</RefCode>
            </div>

            {/* ── Patch: can't change ───────────────── */}
            {mode === 'patch' && (
              <>
                <p id="sdl-patch-frozen" className={styles.refGroupLabel}>Can't be changed</p>
                <div className={styles.refSection}>
                  <p className={styles.refSectionDesc}>These operations will return an error. To make these changes you must create a new collection and migrate data.</p>
                  <ul className={styles.cantChangeList}>
                    {([
                      ['Field name',        'renaming an existing field is not supported'],
                      ['Field type',        'changing a field\'s data type is not supported'],
                      ['@crdt type',        'the CRDT merge strategy is fixed at creation time'],
                      ['@default value',    'existing field defaults cannot be changed'],
                      ['Collection name',   'collection names are immutable'],
                      ['@branchable',       'cannot be toggled after creation'],
                      ['@policy',           'ACP policy cannot be mutated'],
                      ['@index',            'indexes are managed separately — add or drop via index API'],
                      ['Field order',       'reordering fields is not supported'],
                    ] as [string, string][]).map(([label, desc]) => (
                      <li key={label} className={styles.cantChangeItem}>
                        <span className={styles.cantChangeCross}>✕</span>
                        <span className={styles.cantChangeLabel}>{label}</span>
                        <span className={styles.cantChangeDesc}>— {desc}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            {/* ── Indexing & defaults ───────────────── */}
            {mode === 'create' && (
              <>
                <p id="sdl-indexing" className={styles.refGroupLabel}>Indexing &amp; defaults</p>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@index</p>
                  <p className={styles.refSectionDesc}>Without an index, filtering on a field requires scanning every document. Add <code>unique: true</code> to enforce uniqueness. Use <code>name:</code> for a custom index name and <code>direction:</code> to set default sort order.</p>
                  <RefCode>{'name: String @index\nemail: String @index(unique: true)\ncreatedAt: DateTime @index(direction: DESC)\nscore: Int @index(name: "score_idx", direction: ASC)'}</RefCode>
                </div>

                <div id="sdl-default" className={styles.refSection}>
                  <p className={styles.refSectionHead}>@default</p>
                  <p className={styles.refSectionDesc}>Value used when the field is omitted on create. The argument key must match the field type. Use <code>UTC_NOW</code> as a special value for DateTime to default to the current time.</p>
                  <RefCode>{'active: Boolean @default(bool: true)\nage: Int @default(int: 0)\nstatus: String @default(string: "draft")\ncreatedAt: DateTime @default(dateTime: UTC_NOW)\nexpiry: DateTime @default(dateTime: "2030-01-01T00:00:00Z")\nmeta: JSON @default(json: "{}")\nthumb: Blob @default(blob: "ff0099")'}</RefCode>
                </div>

                {/* ── Relations ────────────────────────── */}
                <p id="sdl-relations" className={styles.refGroupLabel}>Relations</p>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>One-to-many</p>
                  <p className={styles.refSectionDesc}>DefraDB stores the FK as a companion <code>*ID</code> field. The <code>@relation</code> name must be the same on both sides of the relation.</p>
                  <RefCode>{'type Post {\n  author: User @relation(name: "user_posts")\n  authorID: ID\n}'}</RefCode>
                </div>

                <div id="sdl-rel-one" className={styles.refSection}>
                  <p className={styles.refSectionHead}>One-to-one</p>
                  <p className={styles.refSectionDesc}><code>@primary</code> marks the owning side, which stores the foreign key. The other side is a back-reference only.</p>
                  <RefCode>{'type Profile {\n  user: User @primary @relation(name: "user_profile")\n  userID: ID\n}'}</RefCode>
                </div>

                <div id="sdl-self-rel" className={styles.refSection}>
                  <p className={styles.refSectionHead}>Self-relation</p>
                  <p className={styles.refSectionDesc}>A type that references itself — useful for trees, hierarchies, or peer graphs.</p>
                  <RefCode>{'type Employee {\n  manager: Employee @primary @relation(name: "reports_to")\n  managerID: ID\n  reports: [Employee]\n}'}</RefCode>
                </div>

                {/* ── Conflict resolution ───────────────── */}
                <p id="sdl-crdt" className={styles.refGroupLabel}>Conflict resolution</p>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@crdt</p>
                  <p className={styles.refSectionDesc}>Controls how concurrent writes to the same field are merged across nodes. Without this, the default is last-write-wins. Use <code>pcounter</code> for increment-only counters (e.g. view counts); <code>pncounter</code> for bidirectional counters (e.g. scores).</p>
                  <RefCode>{'views: Int @crdt(type: pcounter)    # increment only\nscore: Int @crdt(type: pncounter)   # ± delta\nlabel: String @crdt(type: lww)      # last write wins'}</RefCode>
                </div>

                {/* ── Collection-level ──────────────────── */}
                <p id="sdl-collection" className={styles.refGroupLabel}>Collection-level</p>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@branchable</p>
                  <p className={styles.refSectionDesc}>Enables commit-graph branching on this collection, similar to git branches. Use <code>@branchable(if: false)</code> to explicitly disable.</p>
                  <RefCode>{'type Events @branchable {\n  name: String\n}'}</RefCode>
                </div>

                <div id="sdl-policy" className={styles.refSection}>
                  <p className={styles.refSectionHead}>@policy</p>
                  <p className={styles.refSectionDesc}>Attaches an ACP (access-control policy) to the collection. The <code>id</code> must match a policy registered with your ACP provider; <code>resource</code> names the entity within that policy.</p>
                  <RefCode>{'type Users @policy(\n  id: "acpPolicyId",\n  resource: "users"\n) {\n  name: String\n}'}</RefCode>
                </div>

                {/* ── Arrays & encryption ───────────────── */}
                <p className={styles.refGroupLabel}>Arrays &amp; encryption</p>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@constraints</p>
                  <p className={styles.refSectionDesc}>Limits the maximum number of elements in an array field.</p>
                  <RefCode>{'tags: [String] @constraints(size: 10)\nnumbers: [Int!] @constraints(size: 4)'}</RefCode>
                </div>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@encryptedIndex</p>
                  <p className={styles.refSectionDesc}>Enables equality search over encrypted field values without decrypting them. Only <code>"equality"</code> is currently supported.</p>
                  <RefCode>{'email: String @encryptedIndex\ntoken: String @encryptedIndex(type: "equality")'}</RefCode>
                </div>

                {/* ── Embeddings ────────────────────────── */}
                <p className={styles.refGroupLabel}>Embeddings</p>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@embedding</p>
                  <p className={styles.refSectionDesc}>Automatically generates a vector embedding from one or more text fields using an external provider. The field must be of type <code>[Float32!]</code>. Use <code>template</code> to control how fields are combined.</p>
                  <RefCode>{'type Article {\n  title: String\n  body: String\n  embedding: [Float32!] @embedding(\n    provider: "ollama"\n    model: "nomic-embed-text"\n    url: "http://localhost:11434/api"\n    fields: ["title", "body"]\n  )\n}'}</RefCode>
                </div>
              </>
            )}

            {mode === 'patch' && (
              <>
                {/* ── New field directives ──────────────── */}
                <p id="sdl-patch-crdt" className={styles.refGroupLabel}>New field directives</p>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@index</p>
                  <p className={styles.refSectionDesc}>Without an index, filtering on a field requires scanning every document. Add <code>unique: true</code> to enforce uniqueness. Use <code>name:</code> for a custom index name and <code>direction:</code> to set default sort order.</p>
                  <RefCode>{'name: String @index\nemail: String @index(unique: true)\ncreatedAt: DateTime @index(direction: DESC)\nscore: Int @index(name: "score_idx", direction: ASC)'}</RefCode>
                </div>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@default</p>
                  <p className={styles.refSectionDesc}>Value used when the field is omitted on create. The argument key must match the field type. Use <code>UTC_NOW</code> as a special value for DateTime to default to the current time.</p>
                  <RefCode>{'active: Boolean @default(bool: true)\nage: Int @default(int: 0)\nstatus: String @default(string: "draft")\ncreatedAt: DateTime @default(dateTime: UTC_NOW)\nexpiry: DateTime @default(dateTime: "2030-01-01T00:00:00Z")\nmeta: JSON @default(json: "{}")\nthumb: Blob @default(blob: "ff0099")'}</RefCode>
                </div>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@crdt</p>
                  <p className={styles.refSectionDesc}>Controls how concurrent writes to the same field are merged across nodes. Choose carefully — this cannot be changed later. <code>pncounter</code> / <code>pcounter</code> only apply to <code>Int</code> or <code>Float</code> fields and cannot be indexed.</p>
                  <RefCode>{'views: Int @crdt(type: pcounter)    # increment only\nscore: Int @crdt(type: pncounter)   # ± delta\nlabel: String @crdt(type: lww)      # last write wins (default)'}</RefCode>
                </div>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@constraints</p>
                  <p className={styles.refSectionDesc}>Limits the maximum number of elements in an array field.</p>
                  <RefCode>{'tags: [String] @constraints(size: 10)\nnumbers: [Int!] @constraints(size: 4)'}</RefCode>
                </div>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>@embedding</p>
                  <p className={styles.refSectionDesc}>Automatically generates a vector embedding from one or more text fields using an external provider. The field must be of type <code>[Float32!]</code>. Use <code>template</code> to control how fields are combined.</p>
                  <RefCode>{'embedding: [Float32!] @embedding(\n  provider: "ollama"\n  model: "nomic-embed-text"\n  url: "http://localhost:11434/api"\n  fields: ["title", "body"]\n)'}</RefCode>
                </div>

                <div className={styles.refSection}>
                  <p className={styles.refSectionHead}>Note</p>
                  <p className={styles.refSectionDesc}><code>@encryptedIndex</code> cannot be added via patch — DefraDB does not allow encrypted indexes to be mutated after collection creation.</p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
