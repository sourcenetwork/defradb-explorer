import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { closeBrackets } from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'
import { graphql as graphqlExt } from 'cm6-graphql'
import { useConfig } from '../context/ConfigContext'
import { createCollection, patchCollection } from '../api/graphql'
import { queryKeys } from '../lib/queryKeys'
import type { CollectionDescription } from '../api/types'
import styles from './SchemaEditor.module.css'

// ── Highlight + theme (reused from GraphQLEditor) ─────────────────────────────

const highlight = HighlightStyle.define([
  { tag: tags.keyword,      color: '#10CBFF' },
  { tag: tags.typeName,     color: '#e0a96d' },
  { tag: tags.propertyName, color: '#a8d8ff' },
  { tag: tags.name,         color: '#cdd6f4' },
  { tag: tags.string,       color: '#39e265' },
  { tag: tags.number,       color: '#39e265' },
  { tag: tags.bool,         color: '#10CBFF' },
  { tag: tags.comment,      color: '#6c7086', fontStyle: 'italic' },
  { tag: tags.punctuation,  color: '#6c7086' },
  { tag: tags.bracket,      color: '#89b4fa' },
  { tag: tags.operator,     color: '#10CBFF' },
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

// ── SDL editor (CodeMirror) ───────────────────────────────────────────────────

function SDLEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
        closeBrackets(),
        editorTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of(u => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
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

export default function SchemaEditor({ onDone, initialMode = 'create' }: Props) {
  const { config }    = useConfig()
  const queryClient   = useQueryClient()
  const [mode, setMode]       = useState<'create' | 'patch'>(initialMode)
  const [sdl, setSdl]         = useState(initialMode === 'patch' ? PATCH_TEMPLATE : CREATE_TEMPLATE)
  const [result, setResult]   = useState<CollectionDescription[] | null>(null)

  function switchMode(next: 'create' | 'patch') {
    setMode(next)
    setSdl(next === 'create' ? CREATE_TEMPLATE : PATCH_TEMPLATE)
    setResult(null)
  }

  const { mutate, isPending, isError, error, reset } = useMutation({
    mutationFn: async () => {
      if (!sdl.trim()) throw new Error('SDL cannot be empty')
      const fn = mode === 'create' ? createCollection : patchCollection
      return fn(config, sdl)
    },
    onSuccess: data => {
      setResult(data)
      queryClient.invalidateQueries({ queryKey: queryKeys.introspection(config.baseUrl) })
      queryClient.invalidateQueries({ queryKey: queryKeys.collections(config.baseUrl) })
    },
  })

  return (
    <div className={styles.root}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.modeToggle}>
          <button
            className={`${styles.modeBtn} ${mode === 'create' ? styles.modeBtnActive : ''}`}
            onClick={() => switchMode('create')}
          >Create</button>
          <button
            className={`${styles.modeBtn} ${mode === 'patch' ? styles.modeBtnActive : ''}`}
            onClick={() => switchMode('patch')}
          >Patch</button>
        </div>
        <span className={styles.toolbarHint}>
          {mode === 'create' ? 'Define a new type with SDL' : 'Add fields to an existing type — use the exact collection name'}
        </span>
        <div className={styles.toolbarActions}>
          {onDone && (
            <button className={styles.btnSecondary} onClick={onDone}>Cancel</button>
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
        <div className={styles.editorWrap}>
          <SDLEditor value={sdl} onChange={v => { setSdl(v); setResult(null) }} />
        </div>

        <div className={styles.sidebar}>
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
            <p className={styles.refTitle}>SDL reference</p>
            <div className={styles.refSection}>
              <p className={styles.refLabel}>Scalar types</p>
              {['String', 'Int', 'Float', 'Float32', 'Float64', 'Boolean', 'DateTime', 'Blob', 'JSON', 'ID'].map(t => (
                <span key={t} className={styles.refChip}>{t}</span>
              ))}
            </div>
            <div className={styles.refSection}>
              <p className={styles.refLabel}>Required field</p>
              <code className={styles.refCode}>name: String!</code>
            </div>
            <div className={styles.refSection}>
              <p className={styles.refLabel}>Relation</p>
              <code className={styles.refCode}>{'author: User @relation(name: "user_posts")\nauthorID: ID'}</code>
            </div>
            <div className={styles.refSection}>
              <p className={styles.refLabel}>Array (nullable items)</p>
              <code className={styles.refCode}>tags: [String]</code>
            </div>
            <div className={styles.refSection}>
              <p className={styles.refLabel}>Array (non-null items)</p>
              <code className={styles.refCode}>tags: [String!]</code>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
