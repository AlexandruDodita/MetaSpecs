import type { Edge, Node, NodeChange, EdgeChange } from '@xyflow/react'
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react'
import { create } from 'zustand'
import type { AppEdge, AppNode, Layer, LayerGraph } from './types'
import { loadGraph, saveGraph } from './api'

const EMPTY_GRAPH: LayerGraph = { nodes: [], edges: [] }

interface GraphState {
  graphs: Record<Layer, LayerGraph>
  activeLayer: Layer
  dirty: Record<Layer, boolean>
  setActiveLayer: (layer: Layer) => void
  onNodesChange: (layer: Layer, changes: NodeChange[]) => void
  onEdgesChange: (layer: Layer, changes: EdgeChange[]) => void
  onConnect: (layer: Layer, edge: AppEdge) => void
  addNode: (layer: Layer, node: AppNode) => void
  updateNodeData: (layer: Layer, nodeId: string, data: Partial<AppNode['data']>) => void
  persist: (layer: Layer) => Promise<void>
  loadAll: () => Promise<void>
}

const nodesForLayer = (state: GraphState) => state.graphs[state.activeLayer].nodes
const edgesForLayer = (state: GraphState) => state.graphs[state.activeLayer].edges

export const useGraphStore = create<GraphState>((set, get) => ({
  graphs: { backend: EMPTY_GRAPH, db: EMPTY_GRAPH, frontend: EMPTY_GRAPH },
  activeLayer: 'backend',
  dirty: { backend: false, db: false, frontend: false },

  setActiveLayer: (layer) => set({ activeLayer: layer }),

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

  onConnect: (layer, edge) =>
    set((state) => ({
      graphs: {
        ...state.graphs,
        [layer]: { ...state.graphs[layer], edges: [...state.graphs[layer].edges, edge] },
      },
      dirty: { ...state.dirty, [layer]: true },
    })),

  addNode: (layer, node) =>
    set((state) => ({
      graphs: {
        ...state.graphs,
        [layer]: { ...state.graphs[layer], nodes: [...state.graphs[layer].nodes, node] },
      },
      dirty: { ...state.dirty, [layer]: true },
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

  persist: async (layer) => {
    await saveGraph(layer, get().graphs[layer])
    set((state) => ({ dirty: { ...state.dirty, [layer]: false } }))
  },

  loadAll: async () => {
    const [backend, db, frontend] = await Promise.all([
      loadGraph('backend'),
      loadGraph('db'),
      loadGraph('frontend'),
    ])
    set({ graphs: { backend, db, frontend } })
  },
}))

export const useLayerNodes = (layer: Layer) =>
  useGraphStore((state) => state.graphs[layer].nodes)
export const useLayerEdges = (layer: Layer) =>
  useGraphStore((state) => state.graphs[layer].edges)
export const useActiveLayer = () => useGraphStore((state) => state.activeLayer)

export { nodesForLayer, edgesForLayer }
