import { useEffect, useRef } from 'react'
import { EditorView, ViewPlugin, WidgetType, Decoration } from '@codemirror/view'
import { Compartment } from '@codemirror/state'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { EditorState, RangeSetBuilder } from '@codemirror/state'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import { tags } from '@lezer/highlight'

// ── DocID copy widget ─────────────────────────────────────────────────────────

const DOCID_RE = /"(bae-[0-9a-f-]+)"/g

class CopyDocIDWidget extends WidgetType {
  docID: string
  constructor(docID: string) { super(); this.docID = docID }

  eq(other: CopyDocIDWidget) { return other.docID === this.docID }

  toDOM() {
    const btn = document.createElement('button')
    btn.className = 'cm-copy-docid'
    btn.title = `Copy ${this.docID}`
    btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
      <rect x="4" y="4" width="7" height="7" rx="1.2" stroke="currentColor" stroke-width="1.2"/>
      <path d="M3 8H2a1 1 0 01-1-1V2a1 1 0 011-1h5a1 1 0 011 1v1" stroke="currentColor" stroke-width="1.2"/>
    </svg>`
    btn.addEventListener('click', e => {
      e.preventDefault()
      navigator.clipboard.writeText(this.docID).then(() => {
        btn.textContent = '✓'
        btn.classList.add('cm-copy-docid--done')
        setTimeout(() => {
          btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <rect x="4" y="4" width="7" height="7" rx="1.2" stroke="currentColor" stroke-width="1.2"/>
            <path d="M3 8H2a1 1 0 01-1-1V2a1 1 0 011-1h5a1 1 0 011 1v1" stroke="currentColor" stroke-width="1.2"/>
          </svg>`
          btn.classList.remove('cm-copy-docid--done')
        }, 1500)
      })
    })
    return btn
  }

  ignoreEvent() { return false }
}

const docIDCopyPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) { this.decorations = buildCopyDecorations(view) }
  update(u: ViewUpdate) { if (u.docChanged) this.decorations = buildCopyDecorations(u.view) }
}, { decorations: v => v.decorations })

function buildCopyDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const text = view.state.doc.toString()
  const re = new RegExp(DOCID_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const pos = m.index + m[0].length
    builder.add(pos, pos, Decoration.widget({ widget: new CopyDocIDWidget(m[1]), side: 1 }))
  }
  return builder.finish()
}

// ── Open-in-collections widget ────────────────────────────────────────────────

class OpenDocWidget extends WidgetType {
  docID: string
  collection: string
  onOpen: (collection: string, docID: string) => void

  constructor(docID: string, collection: string, onOpen: (c: string, d: string) => void) {
    super()
    this.docID = docID
    this.collection = collection
    this.onOpen = onOpen
  }

  eq(other: OpenDocWidget) { return other.docID === this.docID && other.collection === this.collection }

  toDOM() {
    const btn = document.createElement('button')
    btn.className = 'cm-open-doc'
    btn.title = `Open in Collections (${this.collection})`
    // Small "open" arrow icon
    btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
      <path d="M5 2H2a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <path d="M8 1h3v3M11 1L6.5 5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
    btn.addEventListener('click', e => {
      e.preventDefault()
      this.onOpen(this.collection, this.docID)
    })
    return btn
  }

  ignoreEvent() { return false }
}

function makeOpenDocPlugin(
  docMap: Map<string, string>,
  onOpen: (collection: string, docID: string) => void
) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = buildOpenDecorations(view, docMap, onOpen) }
    update(u: ViewUpdate) { if (u.docChanged) this.decorations = buildOpenDecorations(u.view, docMap, onOpen) }
  }, { decorations: v => v.decorations })
}

function buildOpenDecorations(
  view: EditorView,
  docMap: Map<string, string>,
  onOpen: (c: string, d: string) => void
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const text = view.state.doc.toString()
  const re = new RegExp(DOCID_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const docID = m[1]
    const collection = docMap.get(docID)
    if (collection) {
      const pos = m.index + m[0].length
      builder.add(pos, pos, Decoration.widget({ widget: new OpenDocWidget(docID, collection, onOpen), side: 2 }))
    }
  }
  return builder.finish()
}

// ── Theme ─────────────────────────────────────────────────────────────────────

const jsonHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: '#a8d8ff' },
  { tag: tags.string,       color: '#39e265' },
  { tag: tags.number,       color: '#e0a96d' },
  { tag: tags.bool,         color: '#10CBFF' },
  { tag: tags.null,         color: '#6c7086' },
  { tag: tags.punctuation,  color: '#6c7086' },
  { tag: tags.bracket,      color: '#89b4fa' },
])

const viewerTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', fontFamily: "'CommitMono', monospace" },
  '.cm-content':  { padding: '16px', lineHeight: '1.7' },
  '.cm-scroller': { overflow: 'auto', height: '100%' },
  '.cm-gutters':  { display: 'none' },
  '.cm-line':     { color: 'var(--gray-300)' },
  '&.cm-editor':  { outline: 'none' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(16,203,255,0.12) !important' },
  '.cm-copy-docid, .cm-open-doc': {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '3px', cursor: 'pointer', color: '#888',
    padding: '0px 5px', marginLeft: '4px', verticalAlign: 'middle',
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    fontSize: '10px', fontFamily: 'inherit', lineHeight: '16px',
    transition: 'background 0.1s, color 0.1s, border-color 0.1s',
  },
  '.cm-copy-docid:hover, .cm-open-doc:hover': { background: 'rgba(255,255,255,0.12)', color: '#fff', borderColor: 'rgba(255,255,255,0.25)' },
  '.cm-copy-docid--done': { color: '#39e265 !important', borderColor: 'rgba(57,226,101,0.4) !important', background: 'rgba(57,226,101,0.08) !important' },
  '.cm-open-doc:hover': { color: '#10CBFF !important', borderColor: 'rgba(16,203,255,0.4) !important', background: 'rgba(16,203,255,0.08) !important' },
})

const errorTheme = EditorView.theme({
  '.cm-line': { color: '#FF5F57' },
})

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  value:        string
  isError?:     boolean
  docMap?:      Map<string, string>
  onOpenDoc?:   (collection: string, docID: string) => void
}

export default function JsonViewer({ value, isError, docMap, onOpenDoc }: Props) {
  const containerRef       = useRef<HTMLDivElement>(null)
  const viewRef            = useRef<EditorView | null>(null)
  const openCompartmentRef = useRef(new Compartment())

  useEffect(() => {
    if (!containerRef.current) return
    const openExt = docMap && onOpenDoc
      ? makeOpenDocPlugin(docMap, onOpenDoc)
      : []
    const state = EditorState.create({
      doc: value,
      extensions: [
        json(),
        syntaxHighlighting(jsonHighlight),
        viewerTheme,
        ...(isError ? [errorTheme] : []),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        docIDCopyPlugin,
        openCompartmentRef.current.of(openExt),
      ],
    })
    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update content when value changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  // Reconfigure the open-doc plugin when docMap/onOpenDoc changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const openExt = docMap && onOpenDoc ? makeOpenDocPlugin(docMap, onOpenDoc) : []
    view.dispatch({ effects: openCompartmentRef.current.reconfigure(openExt) })
  }, [docMap, onOpenDoc])

  return (
    <div ref={containerRef} style={{ height: '100%', background: 'var(--black)', overflow: 'hidden' }} />
  )
}
