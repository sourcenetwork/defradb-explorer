import { useEffect, useRef } from 'react'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { json } from '@codemirror/lang-json'
import { tags } from '@lezer/highlight'

const jsonHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: '#a8d8ff' },
  { tag: tags.string,       color: '#39e265' },
  { tag: tags.number,       color: '#e0a96d' },
  { tag: tags.bool,         color: '#10CBFF' },
  { tag: tags.null,         color: '#6c7086' },
  { tag: tags.punctuation,  color: '#6c7086' },
  { tag: tags.bracket,      color: '#89b4fa' },
])

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', fontFamily: "'CommitMono', monospace" },
  '.cm-content':  { padding: '12px 16px', lineHeight: '1.7', caretColor: '#10CBFF' },
  '.cm-scroller': { overflow: 'auto', height: '100%' },
  '.cm-gutters':  { display: 'none' },
  '.cm-line':     { color: 'var(--gray-300)' },
  '.cm-cursor':   { borderLeftColor: '#10CBFF', borderLeftWidth: '2px' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#10CBFF' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(16,203,255,0.15) !important' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(16,203,255,0.15)' },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: 'var(--obsidian)',
    border: '1px solid var(--dark-border)',
    borderRadius: '6px',
    fontSize: '12px',
    fontFamily: "'CommitMono', monospace",
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 12px', color: 'var(--muted)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'rgba(16,203,255,0.1)', color: 'var(--white)' },
  '.cm-completionIcon': { display: 'none' },
})

interface Props {
  value: string
  onChange: (v: string) => void
  placeholderText?: string
}

export default function JsonEditor({ value, onChange, placeholderText = '{}' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!containerRef.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        placeholder(placeholderText),
        json(),
        syntaxHighlighting(jsonHighlight),
        autocompletion(),
        closeBrackets(),
        editorTheme,
        EditorView.updateListener.of(u => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
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
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return (
    <div ref={containerRef} style={{ height: '100%', background: 'var(--dark-surface)', overflow: 'hidden' }} />
  )
}
