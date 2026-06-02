import { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle, useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { executeGraphQL, subscribeGraphQL } from '../api/graphql'
import { useGraphQLSchema } from '../hooks/useGraphQLSchema'
import { useCollections, useCollectionViewNames } from '../hooks/useCollections'
import type { GraphQLResponse } from '../api/types'
import GraphQLEditor from '../components/GraphQLEditor'
import type { GraphQLEditorHandle } from '../components/GraphQLEditor'
import JsonEditor from '../components/JsonEditor'
import JsonViewer from '../components/JsonViewer'
import SchemaExplorer from '../components/SchemaExplorer'
import ResizeHandle from '../components/ResizeHandle'
import { useUIStore } from '../store/uiStore'
import styles from './QueryView.module.css'

// ── Public handle ─────────────────────────────────────────────────────────────

export interface QueryViewHandle {
  openQuery: (query: string) => void
}

export interface QueryViewProps {
  onOpenInCollections?: (collection: string, docID: string) => void
}

// ── Tab model ─────────────────────────────────────────────────────────────────

interface SubscriptionEvent {
  index: number
  timestamp: string
  data: GraphQLResponse
}

type SubStatus = 'idle' | 'listening' | 'complete' | 'error'

interface QueryTab {
  id: string
  name: string
  query: string
  variables: string
  result: GraphQLResponse | null
  elapsed: number | null
  subEvents: SubscriptionEvent[]
  subStatus: SubStatus
}

const DEFAULT_QUERY = `{

}`

const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    types {
      name
      kind
      description
      fields {
        name
        description
        type {
          name
          kind
          ofType {
            name
            kind
            ofType {
              name
              kind
            }
          }
        }
        args {
          name
          type {
            name
            kind
            ofType {
              name
              kind
            }
          }
          defaultValue
        }
      }
      inputFields {
        name
        type {
          name
          kind
          ofType {
            name
            kind
          }
        }
      }
      enumValues {
        name
        description
      }
    }
  }
}`

function makeTab(index: number, query = DEFAULT_QUERY): QueryTab {
  return {
    id: `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: `Query ${index}`,
    query,
    variables: '',
    result: null,
    elapsed: null,
    subEvents: [],
    subStatus: 'idle',
  }
}

function isSubscriptionQuery(query: string): boolean {
  return /^\s*subscription\b/i.test(query.trim())
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'defradb-query-tabs-v2'

type SavedState = {
  tabs: Array<{ id: string; name: string; query: string; variables: string }>
  activeTabId: string
}

function loadSaved(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as SavedState
  } catch { return null }
}

function saveTabs(tabs: QueryTab[], activeTabId: string) {
  try {
    const saved: SavedState = {
      tabs: tabs.map(({ id, name, query, variables }) => ({ id, name, query, variables })),
      activeTabId,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {}
}

// ── Result doc extraction ─────────────────────────────────────────────────────

function extractResultDocs(result: GraphQLResponse | null, knownCollections: Set<string>): { collection: string; docID: string }[] {
  if (!result?.data) return []
  const out: { collection: string; docID: string }[] = []
  for (const [key, val] of Object.entries(result.data)) {
    if (!knownCollections.has(key)) continue
    const rows = Array.isArray(val) ? val : []
    for (const row of rows) {
      if (row && typeof row === 'object' && typeof row._docID === 'string') {
        out.push({ collection: key, docID: row._docID })
      }
    }
  }
  return out
}

// ── Subscription event list ───────────────────────────────────────────────────

function SubscriptionResults({ events, status }: { events: SubscriptionEvent[]; status: SubStatus }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length])

  if (status !== 'complete' && events.length === 0) {
    return (
      <div className={styles.subWaiting}>
        <span className={styles.pulseDot} />
        Waiting for events…
      </div>
    )
  }

  return (
    <div className={styles.subEventList}>
      {events.map(evt => (
        <div key={evt.index} className={styles.subEventItem}>
          <div className={styles.subEventHeader}>
            <span className={styles.subEventNum}>Event {evt.index}</span>
            <span className={styles.subEventTime}>{evt.timestamp}</span>
          </div>
          <pre className={styles.subEventBody}>{JSON.stringify(evt.data, null, 2)}</pre>
        </div>
      ))}
      {status === 'listening' && (
        <div className={styles.subListeningRow}>
          <span className={styles.pulseDot} />
          <span>Listening…</span>
        </div>
      )}
      {status === 'complete' && events.length > 0 && (
        <div className={styles.subCompleteRow}>Subscription complete</div>
      )}
      {status === 'error' && (
        <div className={styles.subErrorRow}>Subscription error</div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

// ── Layout constants ──────────────────────────────────────────────────────────

const MIN_PANEL   = 180
const MIN_SCHEMA  = 240
const MIN_RESULTS = 220
const MIN_VARS    = 60

// ── Component ─────────────────────────────────────────────────────────────────

const QueryView = forwardRef<QueryViewHandle, QueryViewProps>(function QueryView({ onOpenInCollections }, ref) {
  const { config } = useConfig()
  const schema     = useGraphQLSchema()
  const editorRef  = useRef<GraphQLEditorHandle>(null)
  const { data: collections } = useCollections()
  const knownCollections = useMemo(() => new Set(collections?.map(c => c.name) ?? []), [collections])
  const { data: viewNames } = useCollectionViewNames()

  // ── Subscription abort map ─────────────────────────────────────────────────

  const abortMapRef = useRef(new Map<string, AbortController>())

  useEffect(() => {
    return () => { abortMapRef.current.forEach(c => c.abort()) }
  }, [])

  // ── Tab state ──────────────────────────────────────────────────────────────

  const [tabs, setTabsRaw] = useState<QueryTab[]>(() => {
    const saved = loadSaved()
    if (saved?.tabs?.length) {
      return saved.tabs.map(t => ({ ...t, result: null, elapsed: null, subEvents: [], subStatus: 'idle' as SubStatus }))
    }
    return [makeTab(1)]
  })

  const [activeTabId, setActiveTabIdRaw] = useState<string>(() => {
    const saved = loadSaved()
    return saved?.activeTabId ?? tabs[0]?.id ?? ''
  })

  function setTabs(next: QueryTab[] | ((prev: QueryTab[]) => QueryTab[]), id?: string) {
    setTabsRaw(prev => {
      const updated = typeof next === 'function' ? next(prev) : next
      saveTabs(updated, id ?? activeTabId)
      return updated
    })
  }

  function setActiveTabId(id: string) {
    setActiveTabIdRaw(id)
    saveTabs(tabs, id)
    setCursorOffset(null)
  }

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0]

  function updateActiveTab(patch: Partial<QueryTab>) {
    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, ...patch } : t))
  }

  function setQuery(query: string, cursorAt?: number) {
    updateActiveTab({ query })
    if (cursorAt != null) {
      setTimeout(() => editorRef.current?.setCursor(cursorAt), 0)
    }
  }
  function setVariables(variables: string) { updateActiveTab({ variables }) }

  function addTab() {
    const newTab = makeTab(tabs.length + 1)
    setTabs(prev => [...prev, newTab], newTab.id)
    setActiveTabIdRaw(newTab.id)
    setCursorOffset(null)
  }

  useImperativeHandle(ref, () => ({
    openQuery(query: string) {
      const newTab = makeTab(tabs.length + 1)
      newTab.query = query
      setTabs(prev => [...prev, newTab], newTab.id)
      setActiveTabIdRaw(newTab.id)
      setCursorOffset(null)
    },
  }))

  function closeTab(id: string) {
    if (tabs.length <= 1) return
    abortMapRef.current.get(id)?.abort()
    abortMapRef.current.delete(id)
    const idx = tabs.findIndex(t => t.id === id)
    const next = tabs.filter(t => t.id !== id)
    setTabs(next)
    if (activeTabId === id) {
      const fallback = next[Math.min(idx, next.length - 1)]
      setActiveTabId(fallback.id)
    }
  }

  // ── Layout state ───────────────────────────────────────────────────────────

  const showSchema    = useUIStore(s => s.queryShowSchema)
  const setShowSchema = useUIStore(s => s.setQueryShowSchema)
  const varsOpen      = useUIStore(s => s.queryVarsOpen)
  const setVarsOpen   = useUIStore(s => s.setQueryVarsOpen)
  const varsHeight    = useUIStore(s => s.queryVarsHeight)
  const setVarsHeight = useUIStore(s => s.setQueryVarsHeight)
  const schemaWidth   = useUIStore(s => s.querySchemaWidth)
  const setSchemaWidth = useUIStore(s => s.setQuerySchemaWidth)
  const [editorWidth, setEditorWidth] = useState<number | null>(null)
  const [cursorOffset, setCursorOffset] = useState<number | null>(null)

  const schemaWidthRef = useRef(schemaWidth)
  schemaWidthRef.current = schemaWidth

  const varsHeightRef = useRef(varsHeight)
  varsHeightRef.current = varsHeight

  const varsOpenRef = useRef(varsOpen)
  varsOpenRef.current = varsOpen

  const onResizeEditorResults = useCallback((delta: number) => {
    setEditorWidth(prev => {
      const container = document.querySelector('[data-query-view]') as HTMLElement | null
      const total = container?.offsetWidth ?? 1000
      const current = prev ?? (total - schemaWidthRef.current) / 2
      return Math.max(MIN_PANEL, Math.min(total - schemaWidthRef.current - MIN_RESULTS, current + delta))
    })
  }, [])

  const onResizeSchema = useCallback((delta: number) => {
    setSchemaWidth(Math.max(MIN_SCHEMA, Math.min(500, schemaWidthRef.current + delta)))
  }, [setSchemaWidth])

  const onResizeVars = useCallback((delta: number) => {
    setVarsHeight(Math.max(MIN_VARS, Math.min(400, varsHeightRef.current - delta)))
  }, [setVarsHeight])

  // ── Query execution ────────────────────────────────────────────────────────

  const { mutate: runQuery, isPending, isError, error } = useMutation({
    mutationFn: async (q: string) => {
      let vars: Record<string, unknown> | undefined
      if (activeTab.variables.trim()) {
        try { vars = JSON.parse(activeTab.variables) } catch { throw new Error('Invalid JSON in variables') }
      }
      const t0 = performance.now()
      const res = await executeGraphQL(config, q, vars)
      return { res, elapsed: Math.round(performance.now() - t0) }
    },
    onSuccess: ({ res, elapsed }) => {
      setTabs(prev => prev.map(t => t.id === activeTab.id
        ? { ...t, result: res, elapsed, subEvents: [], subStatus: 'idle' }
        : t
      ))
    },
  })

  // ── Subscription execution ─────────────────────────────────────────────────

  async function runSubscription(query: string) {
    const tabId = activeTab.id

    abortMapRef.current.get(tabId)?.abort()
    const controller = new AbortController()
    abortMapRef.current.set(tabId, controller)

    let vars: Record<string, unknown> | undefined
    if (activeTab.variables.trim()) {
      try { vars = JSON.parse(activeTab.variables) }
      catch {
        setTabs(prev => prev.map(t => t.id === tabId
          ? { ...t, result: { errors: [{ message: 'Invalid JSON in variables' }] }, subStatus: 'idle' }
          : t
        ))
        return
      }
    }

    setTabs(prev => prev.map(t => t.id === tabId
      ? { ...t, result: null, elapsed: null, subEvents: [], subStatus: 'listening' }
      : t
    ))

    let index = 0
    try {
      for await (const event of subscribeGraphQL(config, query, vars, controller.signal)) {
        if (controller.signal.aborted) break
        const timestamp = new Date().toLocaleTimeString([], {
          hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
        })
        index++
        setTabs(prev => prev.map(t => t.id === tabId
          ? { ...t, subEvents: [...t.subEvents, { index, timestamp, data: event }] }
          : t
        ))
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setTabs(prev => prev.map(t => t.id === tabId ? { ...t, subStatus: 'complete' } : t))
        abortMapRef.current.delete(tabId)
        return
      }
      setTabs(prev => prev.map(t => t.id === tabId
        ? { ...t, subStatus: 'error', subEvents: [...t.subEvents, { index: index + 1, timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }), data: { errors: [{ message: (err as Error).message }] } }] }
        : t
      ))
      abortMapRef.current.delete(tabId)
      return
    }

    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, subStatus: 'complete' } : t))
    abortMapRef.current.delete(tabId)
  }

  function stopSubscription() {
    abortMapRef.current.get(activeTab.id)?.abort()
  }

  function handleRun() {
    if (isSubscriptionQuery(activeTab.query)) {
      runSubscription(activeTab.query).catch(console.error)
    } else {
      runQuery(activeTab.query)
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────────

  const result  = activeTab.result
  const elapsed = activeTab.elapsed
  const isSubscribing = activeTab.subStatus === 'listening'
  const isSubMode     = activeTab.subStatus !== 'idle'

  const docCount = result?.data
    ? Object.values(result.data).find(Array.isArray)?.length ?? null
    : null
  const resultText = result ? JSON.stringify(result, null, 2) : ''
  const hasError   = !!(result?.errors || isError)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={styles.view} data-query-view>

      {/* ── Left: schema explorer ─────────────────────────────────────────── */}
      {showSchema && schema && (
        <>
          <div className={styles.schemaPanel} style={{ width: schemaWidth }}>
            <SchemaExplorer
              key={activeTabId}
              schema={schema}
              onInsert={setQuery}
              query={activeTab.query}
              onQueryChange={setQuery}
              cursorOffset={cursorOffset}
              viewNames={viewNames}
            />
          </div>
          <ResizeHandle direction="horizontal" onResize={onResizeSchema} />
        </>
      )}

      {/* ── Right: tab bar + editor/results row ───────────────────────────── */}
      <div className={styles.main}>

        {/* Tab bar — spans full width of editor + results */}
        <div className={styles.tabBar}>
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`${styles.tab} ${tab.id === activeTabId ? styles.tabActive : ''}`}
            >
              <button className={styles.tabLabel} onClick={() => setActiveTabId(tab.id)}>
                {tab.subStatus === 'listening' && <span className={styles.tabLiveDot} />}
                {tab.name}
              </button>
              {tabs.length > 1 && (
                <button
                  className={styles.tabClose}
                  onClick={() => closeTab(tab.id)}
                  title="Close tab"
                >×</button>
              )}
            </div>
          ))}
          <button className={styles.tabAdd} onClick={addTab} title="New query">+</button>
        </div>

        <div className={styles.mainContent}>

        {/* ── Center: editor + variables ──────────────────────────────────── */}
        <div
          className={styles.editor}
          style={editorWidth !== null ? { width: editorWidth, flex: 'none' } : undefined}
        >
        {/* Header */}
        <div className={styles.panelHeader}>
          <span className={styles.panelLabel}>Query</span>
          <div className={styles.headerActions}>
            <button className={styles.btnSm} onClick={() => editorRef.current?.prettify()} title="Format query">
              Prettify
            </button>
            <button className={styles.btnSm} onClick={() => setQuery(DEFAULT_QUERY)}>Reset</button>
            <button className={styles.btnSm} onClick={() => setQuery(INTROSPECTION_QUERY)} title="Load introspection query">Introspection</button>
            <button
              className={`${styles.btnSm} ${showSchema ? styles.btnActive : ''}`}
              onClick={() => setShowSchema(!showSchema)}
            >
              Schema
            </button>
            {isSubscribing ? (
              <button
                className={`${styles.btnSm} ${styles.btnStop}`}
                onClick={stopSubscription}
              >
                ■ Stop
              </button>
            ) : (
              <button
                className={`${styles.btnSm} ${styles.btnPrimary}`}
                onClick={handleRun}
                disabled={isPending}
              >
                {isPending ? '…' : '▶ Run'}
              </button>
            )}
          </div>
        </div>

        {/* GraphQL editor */}
        <div className={styles.queryArea}>
          <span className={styles.runShortcut}>⌘ ↵  to run</span>
          <GraphQLEditor
            ref={editorRef}
            value={activeTab.query}
            onChange={setQuery}
            onRun={handleRun}
            schema={schema}
            onCursorOffset={setCursorOffset}
          />
        </div>

        {/* Variables panel */}
        <ResizeHandle
          direction="vertical"
          onResize={delta => {
            if (!varsOpenRef.current && delta < -4) setVarsOpen(true)
            if (varsOpenRef.current) onResizeVars(delta)
          }}
        />
        <div className={styles.varsPanel} style={{ height: varsOpen ? varsHeight : 36 }}>
          <div className={styles.varsTabs}>
            <button
              className={`${styles.varsTab} ${varsOpen ? styles.varsTabActive : ''}`}
              onClick={() => setVarsOpen(!varsOpen)}
            >
              Variables
              {activeTab.variables.trim() && <span className={styles.varsDot} />}
            </button>
            <button
              className={styles.varsClear}
              style={{ visibility: activeTab.variables.trim() ? 'visible' : 'hidden' }}
              onClick={() => setVariables('')}
            >
              Clear
            </button>
          </div>
          {varsOpen && (
            <div className={styles.varsEditor}>
              <JsonEditor
                value={activeTab.variables}
                onChange={setVariables}
                placeholderText={'{\n  "id": ""\n}'}
              />
            </div>
          )}
        </div>
        </div>{/* end editor */}

        <ResizeHandle direction="horizontal" onResize={onResizeEditorResults} />

        {/* ── Results ───────────────────────────────────────────────────────── */}
        <div className={styles.results}>
          <div className={styles.panelHeader}>
            <span className={styles.panelLabel}>Response</span>
            <div className={styles.resultsMeta}>
              {/* Regular query status */}
              {!isSubMode && isPending && <span className={styles.running}>Running…</span>}
              {!isSubMode && !isPending && result && !result.errors && (
                <>
                  {docCount !== null && (
                    <span className={styles.metaChip}>{docCount} doc{docCount !== 1 ? 's' : ''}</span>
                  )}
                  {elapsed !== null && (
                    <span className={`${styles.metaChip} ${styles.metaChipCyan}`}>{elapsed}ms</span>
                  )}
                </>
              )}
              {!isSubMode && !isPending && result?.errors && (
                <span className={`${styles.metaChip} ${styles.metaChipErr}`}>
                  {result.errors.length} error{result.errors.length > 1 ? 's' : ''}
                </span>
              )}
              {!isSubMode && isError && (
                <span className={`${styles.metaChip} ${styles.metaChipErr}`}>
                  {(error as Error).message}
                </span>
              )}
              {/* Subscription status */}
              {isSubMode && (
                <>
                  {isSubscribing && (
                    <span className={`${styles.metaChip} ${styles.metaChipLive}`}>
                      <span className={styles.pulseDot} />
                      Listening
                    </span>
                  )}
                  {activeTab.subEvents.length > 0 && (
                    <span className={styles.metaChip}>
                      {activeTab.subEvents.length} event{activeTab.subEvents.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {activeTab.subStatus === 'complete' && (
                    <span className={`${styles.metaChip} ${styles.metaChipCyan}`}>complete</span>
                  )}
                  {activeTab.subStatus === 'error' && (
                    <span className={`${styles.metaChip} ${styles.metaChipErr}`}>error</span>
                  )}
                </>
              )}
            </div>
            <button className={styles.btnSm} onClick={() => {
              abortMapRef.current.get(activeTab.id)?.abort()
              abortMapRef.current.delete(activeTab.id)
              setTabs(prev => prev.map(t => t.id === activeTab.id
                ? { ...t, result: null, elapsed: null, subEvents: [], subStatus: 'idle' }
                : t
              ))
            }}>
              Clear
            </button>
          </div>

          <div className={styles.resultArea}>
            {isSubMode ? (
              <SubscriptionResults events={activeTab.subEvents} status={activeTab.subStatus} />
            ) : result ? (
              <JsonViewer
                value={resultText}
                isError={hasError}
                docMap={onOpenInCollections ? (() => {
                  const m = new Map<string, string>()
                  extractResultDocs(result, knownCollections).forEach(({ collection, docID }) => m.set(docID, collection))
                  return m
                })() : undefined}
                onOpenDoc={onOpenInCollections}
              />
            ) : (
              <div className={styles.placeholder}>
                <svg width={32} height={32} viewBox="0 0 32 32" fill="none" opacity={0.3}>
                  <circle cx={16} cy={16} r={13} stroke="currentColor" strokeWidth={1.5}/>
                  <path d="M10 16l4 4 8-8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span>Run a query to see results</span>
              </div>
            )}
          </div>
        </div>

        </div>{/* end mainContent */}
      </div>{/* end main */}

    </div>
  )
})

export default QueryView
