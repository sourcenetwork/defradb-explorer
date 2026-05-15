import { useState, useCallback, useMemo, useImperativeHandle, useEffect, useRef, forwardRef, lazy, Suspense } from 'react'
import { buildClientSchema, printType } from 'graphql'
import { useIntrospection } from '../hooks/useIntrospection'
import type { IntrospectionType, IntrospectionField } from '../api/types'
import { getBaseKind } from '../api/graphql'
import ResizeHandle from '../components/ResizeHandle'
const SchemaGraph = lazy(() => import('../components/SchemaGraph'))
import SchemaEditor from '../components/SchemaEditor'
import styles from './SchemaView.module.css'
import { stripDescriptions, highlightSdl, SCALAR_DESCS, attr } from '../lib/sdl'

export interface SchemaViewHandle {
  openCreate:  () => void
  openPatch:   () => void
  selectType:  (name: string) => void
}

const HIDDEN_TYPES = new Set([
  'Boolean', 'Float', 'ID', 'Int', 'String', '__Directive', '__DirectiveLocation',
  '__EnumValue', '__Field', '__InputValue', '__Schema', '__Type',
  'ExplainableMutation', 'ExplainableQuery', 'Mutation', 'Query', 'Subscription',
])

function resolveTypeName(field: IntrospectionField): string {
  let t = field.type
  const wrappers: string[] = []
  while (t.kind === 'NON_NULL' || t.kind === 'LIST') {
    if (t.kind === 'LIST') { wrappers.push('list'); }
    t = t.ofType!
  }
  const name = t.name ?? t.kind
  return wrappers.includes('list') ? `[${name}]` : name
}

const MIN_SIDEBAR  = 180
const MAX_SIDEBAR  = 480
const DEFAULT_SIDEBAR = 280

const SchemaView = forwardRef<SchemaViewHandle>(function SchemaView(_, ref) {
  const { data, isLoading, isError } = useIntrospection()
  const [activeType, setActiveType]     = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR)
  const [viewMode, setViewMode]         = useState<'table' | 'graph' | 'sdl' | 'editor'>('table')
  const [editorMode, setEditorMode]     = useState<'create' | 'patch'>('create')

  useImperativeHandle(ref, () => ({
    openCreate:  () => { setEditorMode('create'); setViewMode('editor') },
    openPatch:   () => { setEditorMode('patch');  setViewMode('editor') },
    selectType:  (name: string) => { setActiveType(name); setViewMode('table') },
  }))

  const onResizeSidebar = useCallback((delta: number) => {
    setSidebarWidth(prev => Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, prev + delta)))
  }, [])

  const userTypes = useMemo((): IntrospectionType[] => {
    if (!data) return []
    return data.__schema.types.filter(
      t => !HIDDEN_TYPES.has(t.name) && !t.name.startsWith('_') && t.kind === 'OBJECT',
    )
  }, [data])

  const enumTypes = useMemo((): IntrospectionType[] => {
    if (!data) return []
    return data.__schema.types.filter(
      t => !HIDDEN_TYPES.has(t.name) && !t.name.startsWith('_') && t.kind === 'ENUM',
    )
  }, [data])

  const selected = useMemo(() => {
    const name = activeType ?? userTypes[0]?.name
    return data?.__schema.types.find(t => t.name === name) ?? null
  }, [data, activeType, userTypes])

  const sdl = useMemo(() => {
    if (!selected?.fields) return ''
    const lines = selected.fields.map(f => {
      const typeName = resolveTypeName(f)
      const req = f.type.kind === 'NON_NULL' ? '!' : ''
      return `  ${f.name}: ${typeName}${req}`
    })
    return `type ${selected.name} {\n${lines.join('\n')}\n}`
  }, [selected])

  const { fullSdl, sdlDescriptions } = useMemo(() => {
    const descriptions = new Map<string, string>()
    for (const t of userTypes) {
      if (t.description) descriptions.set(t.name, t.description)
      if (t.fields) {
        for (const f of t.fields) {
          if (f.description) descriptions.set(`${t.name}.${f.name}`, f.description)
        }
      }
    }
    if (!data) return { fullSdl: '', sdlDescriptions: descriptions }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const schema = buildClientSchema(data as any)
      const sdl = userTypes
        .map(t => {
          const type = schema.getType(t.name)
          return type ? printType(type) : null
        })
        .filter(Boolean)
        .join('\n\n')
      return { fullSdl: sdl, sdlDescriptions: descriptions }
    } catch {
      return { fullSdl: '', sdlDescriptions: descriptions }
    }
  }, [data, userTypes])

  // Editor mode — shown when TabBar "New Type" / "Patch Type" is clicked
  if (viewMode === 'editor') {
    return (
      <div className={styles.schemaShell}>
        <SchemaEditor key={editorMode} initialMode={editorMode} onDone={() => setViewMode('table')} />
      </div>
    )
  }

  // Loading skeleton
  if (isLoading) {
    return (
      <div className={styles.schemaShell}>
        <div className={styles.viewToolbar} />
        <div className={styles.view}>
          <div className={styles.typeSidebar}>
            {[...Array(6)].map((_, i) => (
              <div key={i} className={styles.skeleton} style={{ width: `${50 + i * 8}%`, margin: '4px 8px' }} />
            ))}
          </div>
          <div className={styles.schemaMain} />
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className={styles.schemaShell}>
        <div className={styles.viewToolbar} />
        <div className={styles.errorState}>
          <p>Could not load schema — check your connection.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.schemaShell}>
      {/* Persistent toolbar — always in the same position */}
      <div className={styles.viewToolbar}>
        <div className={styles.viewToggleGroup}>
          <button
            className={`${styles.viewToggle} ${viewMode === 'table' ? styles.viewToggleActive : ''}`}
            onClick={() => setViewMode('table')}
          >Table</button>
          <button
            className={`${styles.viewToggle} ${viewMode === 'graph' ? styles.viewToggleActive : ''}`}
            onClick={() => setViewMode('graph')}
          >Graph</button>
          <button
            className={`${styles.viewToggle} ${viewMode === 'sdl' ? styles.viewToggleActive : ''}`}
            onClick={() => setViewMode('sdl')}
          >SDL</button>
        </div>
      </div>

      {viewMode === 'graph' ? (
        <div className={styles.graphArea}>
          <Suspense fallback={null}>
            <SchemaGraph types={data?.__schema.types ?? []} />
          </Suspense>
        </div>
      ) : viewMode === 'sdl' ? (
        <SdlView sdl={fullSdl} descriptions={sdlDescriptions} />
      ) : (
        <div className={styles.view}>
          <aside className={styles.typeSidebar} style={{ width: sidebarWidth }}>
            {userTypes.length > 0 && (
              <>
                <p className={styles.groupLabel}>Types</p>
                {userTypes.map(t => (
                  <button
                    key={t.name}
                    className={`${styles.typeItem} ${(activeType ?? userTypes[0]?.name) === t.name ? styles.typeActive : ''}`}
                    onClick={() => setActiveType(t.name)}
                  >
                    <span className={styles.typeItemName}>{t.name}</span>
                    <span className={styles.typeKind}>type</span>
                  </button>
                ))}
              </>
            )}
            {enumTypes.length > 0 && (
              <>
                <p className={styles.groupLabel} style={{ marginTop: 12 }}>Enums</p>
                {enumTypes.map(t => (
                  <button
                    key={t.name}
                    className={`${styles.typeItem} ${activeType === t.name ? styles.typeActive : ''}`}
                    onClick={() => setActiveType(t.name)}
                  >
                    <span className={styles.typeItemName}>{t.name}</span>
                    <span className={styles.typeKind}>enum</span>
                  </button>
                ))}
              </>
            )}
          </aside>

          <ResizeHandle direction="horizontal" onResize={onResizeSidebar} />

          {selected ? (
            <div className={styles.schemaMain}>
              <div className={styles.schemaHeader}>
                <h2 className={styles.typeName}>{selected.name}</h2>
                {selected.fields && (
                  <p className={styles.schemaVersion}>{selected.fields.length} fields</p>
                )}
              </div>

              {selected.fields && (
                <table className={styles.fieldsTable}>
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Type</th>
                      <th>Required</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.fields.map(f => {
                      const isRequired = f.type.kind === 'NON_NULL'
                      const baseKind = getBaseKind(f.type)
                      const isRelation = baseKind === 'OBJECT'
                      return (
                        <tr key={f.name}>
                          <td className={styles.fieldName}>{f.name}</td>
                          <td className={`${styles.fieldType} ${isRelation ? styles.fieldTypeRelation : ''}`}>
                            {resolveTypeName(f)}
                          </td>
                          <td className={isRequired ? styles.fieldRequired : styles.fieldOptional}>
                            {isRequired ? 'yes' : 'no'}
                          </td>
                          <td className={styles.fieldDesc}>{f.description ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}

              {selected.enumValues && (
                <div className={styles.enumValues}>
                  {selected.enumValues.map(v => (
                    <span key={v.name} className={styles.enumValue}>{v.name}</span>
                  ))}
                </div>
              )}

              <p className={styles.sdlLabel}>SDL</p>
              <div className={styles.sdlBlock}>
                <pre className={styles.sdlCode}>{sdl}</pre>
              </div>
            </div>
          ) : (
            <div className={styles.schemaMain}>
              <p style={{ color: 'var(--muted)', padding: 24 }}>No types found. Is DefraDB connected?</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ── SDL view ──────────────────────────────────────────────────────────────────


function SdlView({ sdl, descriptions = new Map() }: { sdl: string; descriptions?: Map<string, string> }) {
  const [mode, setMode]       = useState<'pretty' | 'raw'>('pretty')
  const [copied, setCopied]   = useState(false)
  const [cmdHeld, setCmdHeld] = useState(false)
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const preRef = useRef<HTMLPreElement>(null)

  function copy() {
    navigator.clipboard.writeText(sdl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  useEffect(() => {
    const el = preRef.current
    if (!el) return
    function onMove(e: MouseEvent) {
      const target = (e.target as HTMLElement).closest('[data-desc]') as HTMLElement | null
      setTooltip(target ? { text: target.getAttribute('data-desc')!, x: e.clientX, y: e.clientY } : null)
    }
    function onLeave() { setTooltip(null) }
    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    return () => { el.removeEventListener('mousemove', onMove); el.removeEventListener('mouseleave', onLeave) }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Meta') setCmdHeld(e.type === 'keydown') }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey) }
  }, [])

  const clean = useMemo(() => stripDescriptions(sdl), [sdl])
  const highlighted = useMemo(() => highlightSdl(clean, descriptions), [clean, descriptions])
  const typeCount = sdl.split(/^type\s/m).length - 1

  return (
    <div className={styles.sdlFullWrap}>
      <div className={styles.sdlFullToolbar}>
        <span className={styles.sdlFullLabel}>{typeCount} types</span>
        <div className={styles.sdlModeGroup}>
          <button
            className={`${styles.sdlModeBtn} ${mode === 'pretty' ? styles.sdlModeBtnActive : ''}`}
            onClick={() => setMode('pretty')}
          >Pretty</button>
          <button
            className={`${styles.sdlModeBtn} ${mode === 'raw' ? styles.sdlModeBtnActive : ''}`}
            onClick={() => setMode('raw')}
          >Raw</button>
        </div>
        <button className={styles.sdlFullCopy} onClick={copy}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      {mode === 'pretty' ? (
        <pre
          ref={preRef}
          className={`${styles.sdlFullCode} ${cmdHeld ? styles.sdlExpandMode : ''}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className={styles.sdlFullCode}>{sdl}</pre>
      )}
      {mode === 'pretty' && (
        <div className={styles.sdlHint}>
          Hover to inspect · Hold <kbd className={styles.sdlKbd}>⌘</kbd> to expand all
        </div>
      )}
      {tooltip && (
        <div
          className={styles.sdlTooltip}
          style={{ left: tooltip.x + 14, top: tooltip.y - 10 }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  )
}

export default SchemaView
