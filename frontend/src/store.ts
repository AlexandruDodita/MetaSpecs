import type { Edge, Node, NodeChange, EdgeChange } from '@xyflow/react'
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

interface GraphState {
  graphs: Record<Layer, LayerGraph>
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
  setActiveLayer: (layer: Layer) => void
  setTool: (tool: Tool) => void
  setWireSource: (nodeId: string | null) => void
  setSelectedNodeIds: (ids: string[]) => void
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
  cancelEditing: (layer: Layer) => void
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

  setActiveLayer: (layer) => {
    get().commitEditing(get().activeLayer)
    set({ activeLayer: layer, wireSource: null, selectedNodeIds: [] })
  },

  setTool: (tool) => set({ tool, wireSource: null, drawing: null }),

  setWireSource: (nodeId) => set({ wireSource: nodeId }),

  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

  onNodesChange: (layer, changes) =>
    set((state) => ({
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
      dirty: { ...state.dirty, [layer]: true },
    })),

  onEdgesChange: (layer, changes) =>
    set((state) => ({
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
      dirty: { ...state.dirty, [layer]: true },
    })),

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
    })),

  addNodeAt: (layer, node) =>
    set((state) => ({
      graphs: {
        ...state.graphs,
        [layer]: { ...state.graphs[layer], nodes: [...state.graphs[layer].nodes, node] },
      },
      dirty: { ...state.dirty, [layer]: true },
    })),

  removeNodes: (layer, ids) => {
    const idsSet = new Set(ids)
    set((state) => {
      const nodes = state.graphs[layer].nodes.filter((n) => !idsSet.has(n.id))
      const edges = state.graphs[layer].edges.filter(
        (e) => !idsSet.has(e.source) && !idsSet.has(e.target),
      )
      return {
        graphs: { ...state.graphs, [layer]: { nodes, edges } },
        dirty: { ...state.dirty, [layer]: true },
        editingNodeId:
          state.editingNodeId && idsSet.has(state.editingNodeId)
            ? null
            : state.editingNodeId,
        wireSource:
          state.wireSource && idsSet.has(state.wireSource) ? null : state.wireSource,
      }
    })
  },

  removeEdges: (layer, ids) => {
    const idsSet = new Set(ids)
    set((state) => ({
      graphs: {
        ...state.graphs,
        [layer]: {
          ...state.graphs[layer],
          edges: state.graphs[layer].edges.filter((e) => !idsSet.has(e.id)),
        },
      },
      dirty: { ...state.dirty, [layer]: true },
    }))
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

  cancelEditing: (layer) => {
    const { editingNodeId, editDraft } = get()
    if (!editingNodeId || !editDraft) return
    get().updateNodeData(layer, editingNodeId, {
      label: editDraft.label,
      columns: editDraft.columns,
      items: editDraft.items,
    })
    set({ editingNodeId: null, editDraft: null })
  },

  commitEditing: (_layer) => {
    const { editingNodeId } = get()
    if (!editingNodeId) return
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
    set({ graphs: { backend, db, frontend }, loadSeq: get().loadSeq + 1 })
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
export const useActiveLayer = () => useGraphStore((state) => state.activeLayer)
