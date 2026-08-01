import type { Edge, Node, NodeChange, EdgeChange, NodePositionChange } from '@xyflow/react'
import { applyNodeChanges, applyEdgeChanges, MarkerType } from '@xyflow/react'
import { create } from 'zustand'
import type { AppEdge, AppNode, EditDraft, Layer, LayerGraph, ShapeKind } from './types'
import { loadGraph, saveGraph } from './api'
import { DEFAULT_SIZE, uid, makeNodeId, type PlaceableKind } from './nodeFactory'

export type Tool = 'select' | 'rect' | 'circle' | 'table' | 'wire'
export type PlaceableTool = 'rect' | 'circle' | 'table'

/** Live drag-to-draw rectangle in flow coordinates. */
export interface Drawing {
  kind: ShapeKind | 'table'
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
  editingNodeId: string | null
  editDraft: EditDraft | null
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  undo: (layer: Layer) => void
  redo: (layer: Layer) => void
  setActiveLayer: (layer: Layer) => void
  setTool: (tool: Tool) => void
  setWireSource: (nodeId: string | null) => void
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
  }
}

export const useGraphStore = create<GraphState>((set, get) => ({
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
  editingNodeId: null,
  editDraft: null,
  selectedNodeIds: [],
  selectedEdgeIds: [],

  setActiveLayer: (layer) => {
    get().commitEditing(get().activeLayer)
    set({ activeLayer: layer, wireSource: null, selectedNodeIds: [], selectedEdgeIds: [] })
  },

  setTool: (tool) => set({ tool, wireSource: null, drawing: null }),

  setWireSource: (nodeId) => set({ wireSource: nodeId }),

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
    set((state) => ({
      graphs: {
        ...state.graphs,
        [layer]: {
          ...state.graphs[layer],
          edges: [...state.graphs[layer].edges, makeEdge(layer, source, target)],
        },
      },
      dirty: { ...state.dirty, [layer]: true },
      ...pushHistory(state, layer),
    })),

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
    const kind: PlaceableKind =
      node.type === 'shape'
        ? ((node.data as { kind?: ShapeKind }).kind ?? 'rect')
        : 'table'
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

  updateEdgeLabel: (layer, edgeId, label) =>
    set((state) => ({
      graphs: {
        ...state.graphs,
        [layer]: {
          ...state.graphs[layer],
          edges: state.graphs[layer].edges.map((e) =>
            e.id === edgeId ? { ...e, label: label || undefined } : e,
          ),
        },
      },
      dirty: { ...state.dirty, [layer]: true },
      ...pushHistory(state, layer),
    })),

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

  startDrawing: (kind, x, y) => set({ drawing: { kind, x, y, w: 0, h: 0 } }),

  updateDrawing: (x, y) => {
    const d = get().drawing
    if (!d) return
    set({
      drawing: {
        ...d,
        x: Math.min(d.x, x),
        y: Math.min(d.y, y),
        w: Math.abs(x - d.x),
        h: Math.abs(y - d.y),
      },
    })
  },

  finishDrawing: () => set({ drawing: null }),

  startEditing: (layer, nodeId) => {
    const node = get().graphs[layer].nodes.find((n) => n.id === nodeId)
    if (!node) return
    const data = node.data as Partial<{ label: string; columns: ColumnLike[]; items: string[] }>
    set({
      editingNodeId: nodeId,
      editDraft: {
        label: data.label ?? '',
        columns: (data.columns ?? []).map((c) => ({ ...c })),
        items: [...(data.items ?? [])],
      },
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
      })
    } else if (node.type === 'shape') {
      get().updateNodeData(layer, editingNodeId, {
        label: editDraft.label,
        items: editDraft.items,
      })
    }
    set({ editingNodeId: null, editDraft: null })
  },

  persist: async (layer) => {
    const snapshot = get().graphs[layer]
    await saveGraph(layer, snapshot)
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
    const [backend, db, frontend] = await Promise.all([
      loadGraph('backend'),
      loadGraph('db'),
      loadGraph('frontend'),
    ])
    set({
      graphs: { backend, db, frontend },
      past: { backend: [], db: [], frontend: [] },
      future: { backend: [], db: [], frontend: [] },
      loadSeq: get().loadSeq + 1,
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
