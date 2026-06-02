import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { EditorView, keymap, placeholder, lineNumbers, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'
import { graphql as graphqlExt, updateSchema } from 'cm6-graphql'
import { parse, print } from 'graphql'
import type { GraphQLSchema } from 'graphql'
import { gqlRootFieldHighlighter } from '../lib/syntaxDecorators'

export interface GraphQLEditorHandle {
  prettify: () => void
  setCursor: (offset: number) => void
}

// ── Highlight style ───────────────────────────────────────────────────────────

const graphqlHighlight = HighlightStyle.define([
  { tag: tags.keyword,                       color: '#c792ea' },  // query, mutation, fragment, on
  { tag: tags.definitionKeyword,             color: '#c792ea' },  // subscription
  { tag: tags.modifier,                      color: '#c792ea' },  // @directives
  { tag: tags.typeName,                      color: '#10CBFF' },  // type names (type conditions)
  { tag: tags.atom,                          color: '#10CBFF' },  // Name nodes
  { tag: tags.propertyName,                 color: '#a6e3a1' },  // field names: User, _docID, age
  { tag: tags.attributeName,                color: '#e0a96d' },  // argument names: limit, filter
  { tag: tags.name,                          color: '#cdd6f4' },  // general names
  { tag: tags.variableName,                 color: '#c792ea' },  // $variables
  { tag: tags.definition(tags.variableName), color: '#c792ea' },
  { tag: tags.special(tags.name),            color: '#10CBFF' },  // enum values
  { tag: tags.string,                        color: '#39e265' },  // "strings"
  { tag: tags.number,                        color: '#ffcb6b' },  // numbers
  { tag: tags.bool,                          color: '#ffcb6b' },  // true / false
  { tag: tags.null,                          color: '#6c7086' },  // null
  { tag: tags.comment,                       color: '#6c7086', fontStyle: 'italic' },
  { tag: tags.punctuation,                  color: '#6c7086' },  // : , ( )
  { tag: tags.bracket,                       color: '#6c7086' },  // { }
  { tag: tags.operator,                      color: '#6c7086' },  // !
])

// ── Editor theme (structural styles only) ────────────────────────────────────

const dashboardTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    fontFamily: "'CommitMono', 'JetBrains Mono', 'Fira Code', monospace",
  },
  '.cm-content': {
    padding: '16px',
    lineHeight: '1.7',
    caretColor: '#10CBFF',
  },
  '.cm-cursor': { borderLeftColor: '#10CBFF', borderLeftWidth: '2px' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#10CBFF' },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(16, 203, 255, 0.15) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(16, 203, 255, 0.15)',
  },
  '.cm-scroller': { overflow: 'auto', height: '100%' },
  '.cm-gutters': {
    background: 'var(--dark-surface)',
    border: 'none',
    paddingRight: '4px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    color: '#3f4359',
    fontSize: '11px',
    minWidth: '32px',
    paddingRight: '12px',
  },

  // Autocomplete dropdown
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: 'var(--obsidian)',
    border: '1px solid var(--dark-border)',
    borderRadius: '6px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    fontSize: '12px',
    fontFamily: "'CommitMono', monospace",
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { padding: '4px 0' },
  '.cm-tooltip-autocomplete > ul > li': {
    padding: '5px 14px',
    color: 'var(--muted)',
    lineHeight: '1.4',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'rgba(16, 203, 255, 0.1)',
    color: 'var(--white)',
  },
  // Lint / diagnostic tooltip
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
  '.cm-completionIcon': { display: 'none' },
  '.cm-completionLabel': { flex: 1 },
  '.cm-completionDetail': {
    fontStyle: 'normal',
    color: '#10CBFF',
    marginLeft: '12px',
    fontSize: '10px',
    opacity: 0.8,
  },
})

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  value: string
  onChange: (value: string) => void
  onRun: () => void
  schema?: GraphQLSchema | null
  onCursorOffset?: (offset: number) => void
}

const GraphQLEditor = forwardRef<GraphQLEditorHandle, Props>(
function GraphQLEditor({ value, onChange, onRun, schema, onCursorOffset }, ref) {
  const containerRef     = useRef<HTMLDivElement>(null)
  const viewRef          = useRef<EditorView | null>(null)
  const onChangeRef      = useRef(onChange)
  const onRunRef         = useRef(onRun)
  const onCursorRef      = useRef(onCursorOffset)

  onChangeRef.current = onChange
  onRunRef.current    = onRun
  onCursorRef.current = onCursorOffset

  useImperativeHandle(ref, () => ({
    prettify() {
      const view = viewRef.current
      if (!view) return
      const doc = view.state.doc.toString()
      try {
        const pretty = print(parse(doc))
        view.dispatch({ changes: { from: 0, to: doc.length, insert: pretty } })
      } catch { /* invalid query — leave as-is */ }
    },
    setCursor(offset: number) {
      const view = viewRef.current
      if (!view) return
      const clamped = Math.max(0, Math.min(offset, view.state.doc.length))
      view.dispatch({ selection: { anchor: clamped, head: clamped }, scrollIntoView: true })
      view.focus()
    },
  }))

  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        lineNumbers(),
        drawSelection(),
        keymap.of([
          { key: 'Mod-Enter', run: () => { onRunRef.current(); return true } },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        placeholder('{ User { _docID name } }'),
        graphqlExt(),
        syntaxHighlighting(graphqlHighlight),
        ...gqlRootFieldHighlighter(),
        autocompletion({
          compareCompletions: (a, b) => {
            const AGG = new Set(['AVG', 'COUNT', 'MAX', 'MIN', 'SUM', 'SIMILARITY', 'GROUP'])
            const rank = (l: string) => AGG.has(l) ? 1 : 0
            const diff = rank(a.label) - rank(b.label)
            if (diff !== 0) return diff
            return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
          },
        }),
        closeBrackets(),
        dashboardTheme,
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          if (update.selectionSet) onCursorRef.current?.(update.state.selection.main.head)
        }),
        EditorView.lineWrapping,
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    return () => { view.destroy(); viewRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (viewRef.current && schema) updateSchema(viewRef.current, schema)
  }, [schema])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', background: 'var(--dark-surface)', overflow: 'hidden' }}
    />
  )
})

export default GraphQLEditor
