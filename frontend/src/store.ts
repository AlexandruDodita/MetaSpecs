import type { Edge, Node, NodeChange, EdgeChange, NodePositionChange } from '@xyflow/react'
import { applyNodeChanges, applyEdgeChanges, MarkerType } from '@xyflow/react'
import { create } from 'zustand'
import type {
  AppEdge,
  AppNode,
  ClassNodeData,
  EdgeKind,
  EditDraft,
  Field,
  Layer,
  LayerGraph,
  LogicStep,
  Method,
  ProjectInfo,
  ShapeKind,
} from './types'
import { loadGraph, saveGraph } from './api'
import { DEFAULT_SIZE, uid, makeNodeId, placeableKindOf } from './nodeFactory'
import { closestSides } from './geometry'

export type Tool = 'select' | 'rect' | 'circle' | 'table' | 'class' | 'service' | 'file' | 'wire'
export type PlaceableTool = 'rect' | 'circle' | 'table' | 'class' | 'service' | 'file'

/** Expansion defaults: classes and files open, containers (services) closed. */
export const EXPANDED_BY_DEFAULT: Record<'class' | 'service' | 'file', boolean> = {
  class: true,
  service: false,
  file: true,
}

/** The single reading of the shared `expanded` map. */
export const isExpanded = (
  expanded: Record<string, boolean>,
  nodeId: string,
  kind: 'class' | 'service' | 'file',
): boolean => expanded[nodeId] ?? EXPANDED_BY_DEFAULT[kind]

/** Live drag-to-draw rectangle in flow coordinates. */
export interface Drawing {
  kind: ShapeKind | 'table' | 'class' | 'service' | 'file'
  originX: number
  originY: number
  x: number
  y: number
  w: number
  h: number
}

const EMPTY_GRAPH: LayerGraph = { nodes: [], edges: [] }

const HISTORY_LIMIT = 50

function pushHistory(state: GraphState, layer: Layer) {
  return {
    past: {
      ...state.past,
      [layer]: [...state.past[layer], state.graphs[layer]].slice(-HISTORY_LIMIT),
    },
    future: { ...state.future, [layer]: [] },
  }
}

function removeFromGraph(graph: LayerGraph, nodeIds: Set<string>, edgeIds: Set<string>): LayerGraph {
  const nodes = graph.nodes.filter((n) => !nodeIds.has(n.id))
  const edges = graph.edges.filter(
    (e) => !edgeIds.has(e.id) && !nodeIds.has(e.source) && !nodeIds.has(e.target),
  )
  return { nodes, edges }
}

const marksDirty = (c: NodeChange | EdgeChange) => c.type !== 'select' && c.type !== 'dimensions'

interface GraphState {
  project: ProjectInfo | null
  graphs: Record<Layer, LayerGraph>
  past: Record<Layer, LayerGraph[]>
  future: Record<Layer, LayerGraph[]>
  draggingNodes: boolean
  activeLayer: Layer
  dirty: Record<Layer, boolean>
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  saveError: string | null
  loadSeq: number
  tool: Tool
  wireSource: string | null
  drawing: Drawing | null
  /** UI-only edge filter: 'all' or one of the edge kinds. Not persisted. */
  edgeFilter: EdgeKind | 'all'
  editingNodeId: string | null
  editDraft: EditDraft | null
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  /** UI-only: service nodeId → expanded. Not persisted, not in undo history. */
  expanded: Record<string, boolean>
  /** UI-only: class/file nodeId → expanded method id (null = none). Not persisted. */
  expandedMethod: Record<string, string | null>
  toggleExpanded: (nodeId: string, kind: 'class' | 'service' | 'file') => void
  setExpandedMethod: (nodeId: string, methodId: string | null) => void
  updateMethodSteps: (
    layer: Layer,
    nodeId: string,
    methodId: string,
    steps: LogicStep[],
  ) => void
  undo: (layer: Layer) => void
  redo: (layer: Layer) => void
  setProject: (project: ProjectInfo | null) => void
  setActiveLayer: (layer: Layer) => void
  setTool: (tool: Tool) => void
  setWireSource: (nodeId: string | null) => void
  setEdgeFilter: (filter: EdgeKind | 'all') => void
  setSelectedNodeIds: (ids: string[]) => void
  setSelectedEdgeIds: (ids: string[]) => void
  deleteSelection: (layer: Layer) => void
  onNodesChange: (layer: Layer, changes: NodeChange[]) => void
  onEdgesChange: (layer: Layer, changes: EdgeChange[]) => void
  onConnect: (layer: Layer, connection: {
    source: string
    target: string
    sourceHandle?: string | null
    targetHandle?: string | null
  }) => void
  connectNodes: (layer: Layer, source: string, target: string) => void
  addNodeAt: (layer: Layer, node: AppNode) => void
  removeNodes: (layer: Layer, ids: string[]) => void
  removeEdges: (layer: Layer, ids: string[]) => void
  duplicateNode: (layer: Layer, nodeId: string) => void
  clearLayer: (layer: Layer) => void
  updateNodeData: (layer: Layer, nodeId: string, data: Partial<AppNode['data']>) => void
  updateEdgeLabel: (layer: Layer, edgeId: string, label: string) => void
  updateEdgeKind: (layer: Layer, edgeId: string, kind: EdgeKind, protocol: string) => void
  updateNodeSize: (layer: Layer, nodeId: string, width: number, height: number) => void
  startDrawing: (kind: Drawing['kind'], x: number, y: number) => void
  updateDrawing: (x: number, y: number) => void
  finishDrawing: () => void
  startEditing: (layer: Layer, nodeId: string) => void
  updateEditDraft: (patch: Partial<EditDraft>) => void
  cancelEditing: () => void
  commitEditing: (layer: Layer) => void
  persist: (layer: Layer) => Promise<void>
  persistDirty: () => Promise<void>
  loadAll: () => Promise<void>
}

function makeEdge(layer: Layer, source: string, target: string, sourceHandle?: string | null, targetHandle?: string | null): AppEdge {
  return {
    id: uid(`e-${layer}`),
    source,
    target,
    sourceHandle: sourceHandle ?? undefined,
    targetHandle: targetHandle ?? undefined,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: '#7a8bff' },
    labelStyle: { fill: '#dfe6ff', fontSize: 11, fontWeight: 600 },
    labelBgPadding: [4, 4] as [number, number],
    labelBgBorderRadius: 4,
    labelBgStyle: { fill: '#1f2127', fillOpacity: 0.9 },
    kind: 'depends-on',
    protocol: '',
  }
}

/** Shared immutable edge patch: update fields, mark dirty, push undo history. */
function patchEdge(layer: Layer, edgeId: string, patch: Partial<AppEdge>) {
  return (state: GraphState) => ({
    graphs: {
      ...state.graphs,
      [layer]: {
        ...state.graphs[layer],
        edges: state.graphs[layer].edges.map((e) =>
          e.id === edgeId ? { ...e, ...patch } : e,
        ),
      },
    },
    dirty: { ...state.dirty, [layer]: true },
    ...pushHistory(state, layer),
  })
}

/** Rewrite pre-side-handle edge ids ('out'/'in') to the new four-side names. */
function migrateEdgeHandles(graph: LayerGraph): LayerGraph {
  return {
    ...graph,
    edges: graph.edges.map((e) => ({
      ...e,
      sourceHandle: e.sourceHandle === 'out' ? 'right' : e.sourceHandle,
      targetHandle: e.targetHandle === 'in' ? 'left' : e.targetHandle,
    })),
  }
}

export const useGraphStore = create<GraphState>((set, get) => ({
  project: null,
  graphs: { backend: EMPTY_GRAPH, db: EMPTY_GRAPH, frontend: EMPTY_GRAPH },
  past: { backend: [], db: [], frontend: [] },
  future: { backend: [], db: [], frontend: [] },
  draggingNodes: false,
  activeLayer: 'backend',
  dirty: { backend: false, db: false, frontend: false },
  saveState: 'idle',
  saveError: null,
  loadSeq: 0,
  tool: 'select',
  wireSource: null,
  drawing: null,
  edgeFilter: 'all',
  editingNodeId: null,
  editDraft: null,
  selectedNodeIds: [],
  selectedEdgeIds: [],
  expanded: {},
  expandedMethod: {},

  toggleExpanded: (nodeId, kind) =>
    set((state) => ({
      expanded: {
        ...state.expanded,
        [nodeId]: !isExpanded(state.expanded, nodeId, kind),
      },
    })),

  setExpandedMethod: (nodeId, methodId) =>
    set((state) => ({ expandedMethod: { ...state.expandedMethod, [nodeId]: methodId } })),

  setActiveLayer: (layer) => {
    get().commitEditing(get().activeLayer)
    set({ activeLayer: layer, wireSource: null, selectedNodeIds: [], selectedEdgeIds: [] })
  },

  setProject: (project) =>
    set({
      project,
      editingNodeId: null,
      editDraft: null,
      wireSource: null,
      drawing: null,
      selectedNodeIds: [],
      selectedEdgeIds: [],
      tool: 'select',
      expanded: {},
      expandedMethod: {},
    }),

  setTool: (tool) => set({ tool, wireSource: null, drawing: null }),

  setWireSource: (nodeId) => set({ wireSource: nodeId }),

  setEdgeFilter: (filter) => set({ edgeFilter: filter }),

  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

  setSelectedEdgeIds: (ids) => set({ selectedEdgeIds: ids }),

  undo: (layer) =>
    set((state) => {
      if (state.past[layer].length === 0) return {}
      const previous = state.past[layer][state.past[layer].length - 1]
      return {
        graphs: { ...state.graphs, [layer]: previous },
        past: { ...state.past, [layer]: state.past[layer].slice(0, -1) },
        future: {
          ...state.future,
          [layer]: [state.graphs[layer], ...state.future[layer]],
        },
        dirty: { ...state.dirty, [layer]: true },
        editingNodeId: null,
        editDraft: null,
      }
    }),

  redo: (layer) =>
    set((state) => {
      if (state.future[layer].length === 0) return {}
      const [next, ...rest] = state.future[layer]
      return {
        graphs: { ...state.graphs, [layer]: next },
        past: { ...state.past, [layer]: [...state.past[layer], state.graphs[layer]] },
        future: { ...state.future, [layer]: rest },
        dirty: { ...state.dirty, [layer]: true },
        editingNodeId: null,
        editDraft: null,
      }
    }),

  onNodesChange: (layer, changes) =>
    set((state) => {
      const firstDrag =
        !state.draggingNodes &&
        changes.some(
          (c) => c.type === 'position' && (c as NodePositionChange).dragging === true,
        )
      const dragEnd = changes.some(
        (c) => c.type === 'position' && (c as NodePositionChange).dragging === false,
      )
      const marksHistory = changes.some(
        (c) => c.type === 'add' || c.type === 'remove' || c.type === 'replace',
      )
      const history = firstDrag || marksHistory ? pushHistory(state, layer) : {}
      return {
        graphs: {
          ...state.graphs,
          [layer]: {
            ...state.graphs[layer],
            nodes: applyNodeChanges(
              changes as unknown as NodeChange[],
              state.graphs[layer].nodes as unknown as Node[],
            ) as unknown as AppNode[],
          },
        },
        dirty: {
          ...state.dirty,
          [layer]: changes.some(marksDirty) ? true : state.dirty[layer],
        },
        draggingNodes: dragEnd ? false : firstDrag ? true : state.draggingNodes,
        ...history,
      }
    }),

  onEdgesChange: (layer, changes) =>
    set((state) => {
      const marksHistory = changes.some(
        (c) => c.type === 'add' || c.type === 'remove' || c.type === 'replace',
      )
      const history = marksHistory ? pushHistory(state, layer) : {}
      return {
        graphs: {
          ...state.graphs,
          [layer]: {
            ...state.graphs[layer],
            edges: applyEdgeChanges(
              changes as unknown as EdgeChange[],
              state.graphs[layer].edges as unknown as Edge[],
            ) as unknown as AppEdge[],
          },
        },
        dirty: {
          ...state.dirty,
          [layer]: changes.some(marksDirty) ? true : state.dirty[layer],
        },
        ...history,
      }
    }),

  onConnect: (layer, connection) =>
    set((state) => ({
      graphs: {
        ...state.graphs,
        [layer]: {
          ...state.graphs[layer],
          edges: [
            ...state.graphs[layer].edges,
            makeEdge(
              layer,
              connection.source,
              connection.target,
              connection.sourceHandle,
              connection.targetHandle,
            ),
          ],
        },
      },
      dirty: { ...state.dirty, [layer]: true },
      ...pushHistory(state, layer),
    })),

  connectNodes: (layer, source, target) =>
    set((state) => {
      const sourceNode = state.graphs[layer].nodes.find((n) => n.id === source)
      const targetNode = state.graphs[layer].nodes.find((n) => n.id === target)
      let sourceHandle: string | null = null
      let targetHandle: string | null = null
      if (sourceNode && targetNode) {
        const { sourceSide, targetSide } = closestSides(sourceNode, targetNode)
        sourceHandle = sourceSide
        targetHandle = targetSide
      }
      return {
        graphs: {
          ...state.graphs,
          [layer]: {
            ...state.graphs[layer],
            edges: [
              ...state.graphs[layer].edges,
              makeEdge(layer, source, target, sourceHandle, targetHandle),
            ],
          },
        },
        dirty: { ...state.dirty, [layer]: true },
        ...pushHistory(state, layer),
      }
    }),

  addNodeAt: (layer, node) =>
    set((state) => ({
      graphs: {
        ...state.graphs,
        [layer]: { ...state.graphs[layer], nodes: [...state.graphs[layer].nodes, node] },
      },
      dirty: { ...state.dirty, [layer]: true },
      ...pushHistory(state, layer),
    })),

  removeNodes: (layer, ids) => {
    const idsSet = new Set(ids)
    set((state) => {
      const { nodes, edges } = removeFromGraph(state.graphs[layer], idsSet, new Set())
      return {
        graphs: { ...state.graphs, [layer]: { nodes, edges } },
        dirty: { ...state.dirty, [layer]: true },
        editingNodeId:
          state.editingNodeId && idsSet.has(state.editingNodeId)
            ? null
            : state.editingNodeId,
        editDraft:
          state.editingNodeId && idsSet.has(state.editingNodeId)
            ? null
            : state.editDraft,
        wireSource:
          state.wireSource && idsSet.has(state.wireSource) ? null : state.wireSource,
        ...pushHistory(state, layer),
      }
    })
  },

  removeEdges: (layer, ids) => {
    const idsSet = new Set(ids)
    set((state) => {
      const { nodes, edges } = removeFromGraph(state.graphs[layer], new Set(), idsSet)
      return {
        graphs: { ...state.graphs, [layer]: { nodes, edges } },
        dirty: { ...state.dirty, [layer]: true },
        ...pushHistory(state, layer),
      }
    })
  },

  deleteSelection: (layer) => {
    const { selectedNodeIds, selectedEdgeIds } = get()
    if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return
    const nodeIds = new Set(selectedNodeIds)
    const edgeIds = new Set(selectedEdgeIds)
    set((state) => {
      const { nodes, edges } = removeFromGraph(state.graphs[layer], nodeIds, edgeIds)
      return {
        graphs: { ...state.graphs, [layer]: { nodes, edges } },
        dirty: { ...state.dirty, [layer]: true },
        editingNodeId:
          state.editingNodeId && nodeIds.has(state.editingNodeId)
            ? null
            : state.editingNodeId,
        editDraft:
          state.editingNodeId && nodeIds.has(state.editingNodeId)
            ? null
            : state.editDraft,
        wireSource:
          state.wireSource && nodeIds.has(state.wireSource) ? null : state.wireSource,
        selectedNodeIds: [],
        selectedEdgeIds: [],
        ...pushHistory(state, layer),
      }
    })
  },

  duplicateNode: (layer, nodeId) => {
    const state = get()
    const node = state.graphs[layer].nodes.find((n) => n.id === nodeId)
    if (!node) return
    const kind = placeableKindOf(node)
    const width = (node.style?.width as number | undefined) ?? DEFAULT_SIZE[kind].width
    const copy: AppNode = {
      ...node,
      id: makeNodeId(),
      position: { x: node.position.x + width + 24, y: node.position.y },
      selected: false,
    }
    get().addNodeAt(layer, copy)
  },

  clearLayer: (layer) =>
    set((state) => ({
      graphs: { ...state.graphs, [layer]: { nodes: [], edges: [] } },
      dirty: { ...state.dirty, [layer]: true },
      editingNodeId: null,
      editDraft: null,
      wireSource: null,
      drawing: null,
      selectedNodeIds: [],
      ...pushHistory(state, layer),
    })),

  updateNodeData: (layer, nodeId, data) =>
    set((state) => ({
      graphs: {
        ...state.graphs,
        [layer]: {
          ...state.graphs[layer],
          nodes: state.graphs[layer].nodes.map((n) =>
            n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n,
          ),
        },
      },
      dirty: { ...state.dirty, [layer]: true },
      ...pushHistory(state, layer),
    })),

  updateMethodSteps: (layer, nodeId, methodId, steps) => {
    const state = get()
    const node = state.graphs[layer].nodes.find((n) => n.id === nodeId)
    if (!node || (node.type !== 'class' && node.type !== 'file')) return
    const data = node.data as ClassNodeData
    const methods = (data.methods ?? []).map((m) =>
      m.id === methodId
        ? { ...m, steps: steps.map((s) => ({ ...s })) }
        : m,
    )
    get().updateNodeData(layer, nodeId, { methods })
  },

  updateEdgeLabel: (layer, edgeId, label) =>
    set(patchEdge(layer, edgeId, { label: label || undefined })),

  updateEdgeKind: (layer, edgeId, kind, protocol) =>
    set(patchEdge(layer, edgeId, { kind, protocol })),

  updateNodeSize: (layer, nodeId, width, height) =>
    set((state) => ({
      graphs: {
        ...state.graphs,
        [layer]: {
          ...state.graphs[layer],
          nodes: state.graphs[layer].nodes.map((n) =>
            n.id === nodeId
              ? { ...n, style: { ...n.style, width, height } }
              : n,
          ),
        },
      },
      dirty: { ...state.dirty, [layer]: true },
      ...pushHistory(state, layer),
    })),

  startDrawing: (kind, x, y) =>
    set({ drawing: { kind, originX: x, originY: y, x, y, w: 0, h: 0 } }),

  updateDrawing: (x, y) => {
    const d = get().drawing
    if (!d) return
    set({
      drawing: {
        ...d,
        x: Math.min(d.originX, x),
        y: Math.min(d.originY, y),
        w: Math.abs(x - d.originX),
        h: Math.abs(y - d.originY),
      },
    })
  },

  finishDrawing: () => set({ drawing: null }),

  startEditing: (layer, nodeId) => {
    const node = get().graphs[layer].nodes.find((n) => n.id === nodeId)
    if (!node) return
    const data = node.data as Partial<{
      label: string
      columns: ColumnLike[]
      items: string[]
      fields: Field[]
      methods: Method[]
      path: string
      description: string
    }>
    const draft: EditDraft = {
      label: data.label ?? '',
      columns: (data.columns ?? []).map((c) => ({ ...c })),
      items: [...(data.items ?? [])],
      fields: (data.fields ?? []).map((f) => ({ ...f })),
      methods: (data.methods ?? []).map((m) => ({
        ...m,
        steps: (m.steps ?? []).map((s) => ({ ...s })),
      })),
      path: data.path ?? '',
      description: data.description ?? '',
    }
    set({
      editingNodeId: nodeId,
      editDraft: draft,
      selectedNodeIds: [nodeId],
    })
  },

  updateEditDraft: (patch) => {
    const draft = get().editDraft
    if (!draft) return
    set({ editDraft: { ...draft, ...patch } })
  },

  cancelEditing: () => {
    set({ editingNodeId: null, editDraft: null })
  },

  commitEditing: (layer) => {
    const { editingNodeId, editDraft } = get()
    if (!editingNodeId || !editDraft) return
    const node = get().graphs[layer].nodes.find((n) => n.id === editingNodeId)
    if (!node) {
      set({ editingNodeId: null, editDraft: null })
      return
    }
    if (node.type === 'table') {
      get().updateNodeData(layer, editingNodeId, {
        label: editDraft.label,
        columns: editDraft.columns,
        path: editDraft.path,
        description: editDraft.description,
      })
    } else if (node.type === 'shape') {
      get().updateNodeData(layer, editingNodeId, {
        label: editDraft.label,
        items: editDraft.items,
        path: editDraft.path,
        description: editDraft.description,
      })
    } else if (node.type === 'class') {
      get().updateNodeData(layer, editingNodeId, {
        label: editDraft.label,
        fields: editDraft.fields,
        methods: editDraft.methods,
        path: editDraft.path,
        description: editDraft.description,
      })
    } else if (node.type === 'service') {
      get().updateNodeData(layer, editingNodeId, {
        label: editDraft.label,
        path: editDraft.path,
        description: editDraft.description,
      })
    } else if (node.type === 'file') {
      get().updateNodeData(layer, editingNodeId, {
        label: editDraft.label,
        path: editDraft.path,
        description: editDraft.description,
      })
    }
    set({ editingNodeId: null, editDraft: null })
  },

  persist: async (layer) => {
    const projectId = get().project?.id
    if (!projectId) return
    const snapshot = get().graphs[layer]
    await saveGraph(projectId, layer, snapshot)
    set((state) =>
      state.graphs[layer] === snapshot
        ? { dirty: { ...state.dirty, [layer]: false } }
        : {},
    )
  },

  persistDirty: async () => {
    const { dirty } = get()
    const layers = (Object.keys(dirty) as Layer[]).filter((l) => dirty[l])
    if (layers.length === 0) return
    set({ saveState: 'saving' })
    try {
      for (const layer of layers) await get().persist(layer)
      const stillDirty = Object.values(get().dirty).some(Boolean)
      set({ saveState: stillDirty ? 'saving' : 'saved', saveError: null })
    } catch (e) {
      set({ saveState: 'error', saveError: e instanceof Error ? e.message : String(e) })
      throw e
    }
  },

  loadAll: async () => {
    const projectId = get().project?.id
    if (!projectId) return
    const layers: Layer[] = ['backend', 'db', 'frontend']
    const loaded = await Promise.all(layers.map((layer) => loadGraph(projectId, layer)))
    const graphs = Object.fromEntries(
      layers.map((layer, i) => [layer, migrateEdgeHandles(loaded[i])]),
    ) as Record<Layer, LayerGraph>
    set({
      graphs,
      past: { backend: [], db: [], frontend: [] },
      future: { backend: [], db: [], frontend: [] },
      loadSeq: get().loadSeq + 1,
      expanded: {},
      expandedMethod: {},
      dirty: { backend: false, db: false, frontend: false },
      saveState: 'saved',
      saveError: null,
    })
  },
}))

interface ColumnLike {
  name: string
  type: string
  constraint: string
}

export const useLayerNodes = (layer: Layer) =>
  useGraphStore((state) => state.graphs[layer].nodes)
export const useLayerEdges = (layer: Layer) =>
  useGraphStore((state) => state.graphs[layer].edges)
export const useCanUndo = (layer: Layer) =>
  useGraphStore((state) => state.past[layer].length > 0)
export const useCanRedo = (layer: Layer) =>
  useGraphStore((state) => state.future[layer].length > 0)
export const useActiveLayer = () => useGraphStore((state) => state.activeLayer)
