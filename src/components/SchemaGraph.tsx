import { useMemo, useCallback, useRef, useState } from 'react'
import dagre from '@dagrejs/dagre'
import { toPng } from 'html-to-image'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  BackgroundVariant,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { IntrospectionType, IntrospectionField } from '../api/types'
import styles from './SchemaGraph.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBaseTypeName(field: IntrospectionField): string {
  let t = field.type
  while (t.kind === 'NON_NULL' || t.kind === 'LIST') t = t.ofType!
  return t.name ?? ''
}

function getBaseKind(field: IntrospectionField): string {
  let t = field.type
  while (t.kind === 'NON_NULL' || t.kind === 'LIST') t = t.ofType!
  return t.kind
}

function resolveTypeName(field: IntrospectionField): string {
  let t = field.type
  const wrappers: string[] = []
  while (t.kind === 'NON_NULL' || t.kind === 'LIST') {
    if (t.kind === 'LIST') wrappers.push('list')
    t = t.ofType!
  }
  const name = t.name ?? t.kind
  return wrappers.includes('list') ? `[${name}]` : name
}

// ── Custom node ───────────────────────────────────────────────────────────────

interface TypeNodeData {
  label: string
  fields: IntrospectionField[]
  typeNames: Set<string>
  [key: string]: unknown
}

function TypeNode({ data }: NodeProps<Node<TypeNodeData>>) {
  const { label, fields, typeNames } = data
  return (
    <div className={styles.node}>
      <Handle type="target" position={Position.Left}  className={styles.handle} />
      <Handle type="source" position={Position.Right} className={styles.handle} />

      <div className={styles.nodeHeader}>
        <span className={styles.nodeTitle}>{label}</span>
        <span className={styles.nodeKind}>type</span>
      </div>

      <div className={styles.nodeFields}>
        {fields.filter(f => !f.name.startsWith('_')).map(f => {
          const typeName  = resolveTypeName(f)
          const isRelation = getBaseKind(f) === 'OBJECT' && typeNames.has(getBaseTypeName(f))
          const isScalar  = !isRelation
          return (
            <div key={f.name} className={styles.nodeField}>
              <span className={styles.nodeFieldName}>{f.name}</span>
              <span className={`${styles.nodeFieldType} ${isRelation ? styles.nodeFieldRelation : isScalar ? styles.nodeFieldScalar : ''}`}>
                {typeName}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const nodeTypes = { typeNode: TypeNode }

// ── Layout ────────────────────────────────────────────────────────────────────

const NODE_W      = 240
const NODE_H_BASE = 52   // header
const NODE_H_FIELD = 28  // per field

function nodeHeight(t: IntrospectionType) {
  const visible = (t.fields ?? []).filter(f => !f.name.startsWith('_'))
  return NODE_H_BASE + visible.length * NODE_H_FIELD + 16
}

function computeDagreLayout(
  types: IntrospectionType[],
  typeNames: Set<string>,
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 80, edgesep: 20, align: 'UL' })
  g.setDefaultEdgeLabel(() => ({}))

  types.forEach(t => {
    g.setNode(t.name, { width: NODE_W, height: nodeHeight(t) })
  })

  types.forEach(t => {
    ;(t.fields ?? []).forEach(f => {
      if (f.name.startsWith('_')) return
      let cur = f.type
      while (cur.kind === 'NON_NULL' || cur.kind === 'LIST') cur = cur.ofType!
      if (cur.kind !== 'OBJECT' || !typeNames.has(cur.name!) || cur.name === t.name) return
      g.setEdge(t.name, cur.name!)
    })
  })

  dagre.layout(g)

  const positions = new Map<string, { x: number; y: number }>()
  types.forEach(t => {
    const n = g.node(t.name)
    positions.set(t.name, { x: n.x - NODE_W / 2, y: n.y - nodeHeight(t) / 2 })
  })
  return positions
}

// ── Graph inner ───────────────────────────────────────────────────────────────

const HIDDEN_TYPES = new Set([
  'Boolean', 'Float', 'ID', 'Int', 'String',
  '__Directive', '__DirectiveLocation', '__EnumValue', '__Field',
  '__InputValue', '__Schema', '__Type',
  'ExplainableMutation', 'ExplainableQuery', 'Mutation', 'Query', 'Subscription',
])

function ExportButton({ canvasRef }: { canvasRef: React.RefObject<HTMLDivElement | null> }) {
  const [exporting, setExporting] = useState(false)
  const { getNodes } = useReactFlow()

  async function handleExport() {
    const el = canvasRef.current
    if (!el || exporting) return
    setExporting(true)
    try {
      const nodeCount = getNodes().length
      const url = await toPng(el, {
        backgroundColor: '#0a0a0a',
        pixelRatio: 2,
        filter: node => !(node instanceof HTMLElement && node.classList.contains('react-flow__minimap')),
        // Ensure we capture enough of the graph
        width: el.offsetWidth,
        height: Math.max(el.offsetHeight, nodeCount * 60),
      })
      const a = document.createElement('a')
      a.download = 'schema-graph.png'
      a.href = url
      a.click()
    } finally {
      setExporting(false)
    }
  }

  return (
    <button className={styles.exportBtn} onClick={handleExport} disabled={exporting}>
      {exporting ? 'Exporting…' : '↓ Export PNG'}
    </button>
  )
}

function SchemaGraphInner({ types }: { types: IntrospectionType[] }) {
  const userTypes = useMemo(
    () => types.filter(t => !HIDDEN_TYPES.has(t.name) && !t.name.startsWith('_') && t.kind === 'OBJECT'),
    [types],
  )

  const typeNames = useMemo(() => new Set(userTypes.map(t => t.name)), [userTypes])

  const layout = useMemo(() => computeDagreLayout(userTypes, typeNames), [userTypes, typeNames])

  const initialNodes = useMemo<Node[]>(() =>
    userTypes.map(t => ({
      id: t.name,
      type: 'typeNode',
      position: layout.get(t.name) ?? { x: 0, y: 0 },
      data: { label: t.name, fields: t.fields ?? [], typeNames },
      style: { width: NODE_W },
    })),
    [userTypes, layout, typeNames],
  )

  const initialEdges = useMemo<Edge[]>(() => {
    const edges: Edge[] = []
    const seen = new Set<string>()
    userTypes.forEach(t => {
      (t.fields ?? []).forEach(f => {
        if (f.name.startsWith('_')) return
        const baseKind = getBaseKind(f)
        const baseName = getBaseTypeName(f)
        if (baseKind !== 'OBJECT') return
        if (!typeNames.has(baseName)) return
        if (t.name === baseName) return  // self-ref
        const key = `${t.name}→${baseName}:${f.name}`
        if (seen.has(key)) return
        seen.add(key)
        edges.push({
          id: key,
          source: t.name,
          target: baseName,
          label: f.name,
          type: 'smoothstep',
          animated: false,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#10CBFF', width: 14, height: 14 },
          style: { stroke: '#10CBFF', strokeWidth: 1.5, opacity: 0.7 },
          labelStyle: { fill: '#939598', fontSize: 10, fontFamily: 'CommitMono, monospace' },
          labelBgStyle: { fill: '#111111', fillOpacity: 0.9 },
          labelBgPadding: [4, 2],
        })
      })
    })
    return edges
  }, [userTypes, typeNames])

  const [nodes, , onNodesChange] = useNodesState(initialNodes)
  const [edges, , onEdgesChange] = useEdgesState(initialEdges)
  const { fitView } = useReactFlow()
  const canvasRef = useRef<HTMLDivElement>(null)

  const onInit = useCallback(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 })))
  }, [fitView])

  if (userTypes.length === 0) {
    return (
      <div className={styles.empty}>
        No schema types found. Is DefraDB connected?
      </div>
    )
  }

  return (
    <div className={styles.canvas} ref={canvasRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onInit={onInit}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="#222222"
        />
        <MiniMap
          nodeColor="#1A1A1A"
          maskColor="rgba(0,0,0,0.6)"
          className={styles.minimap}
        />
      </ReactFlow>
      <ExportButton canvasRef={canvasRef} />
    </div>
  )
}

// ── Public export (wrapped in provider) ──────────────────────────────────────

export default function SchemaGraph({ types }: { types: IntrospectionType[] }) {
  return (
    <ReactFlowProvider>
      <SchemaGraphInner types={types} />
    </ReactFlowProvider>
  )
}
