import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Context, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  ConnectionMode,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react'
import type {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  NodeMouseHandler,
  NodeTypes,
} from '@xyflow/react'
import type { AppEdge, AppNode, NestedFlow as NestedFlowGraph } from '../types'
import type { MenuItem } from '../menu/types'
import { ContextMenu } from './ContextMenu'

export interface NestedFlowProps {
  nodes: AppNode[]
  edges: AppEdge[]
  nodeTypes: NodeTypes
  className: string
  onChange: (graph: NestedFlowGraph) => void
  onPaneContextMenu?: (position: { x: number; y: number }, graph: NestedFlowGraph) => MenuItem[]
  onNodeContextMenu?: (node: AppNode, graph: NestedFlowGraph) => MenuItem[]
}

export interface NestedFlowContextValue {
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void
  updateEdgeLabel: (edgeId: string, label: string) => void
}

export const NestedFlowContext: Context<NestedFlowContextValue | null> =
  createContext<NestedFlowContextValue | null>(null)

export function useNestedFlowContext(): NestedFlowContextValue | null {
  return useContext(NestedFlowContext)
}

const DEBOUNCE_MS = 400

interface MenuState {
  items: MenuItem[]
  x: number
  y: number
}

function NestedFlowInner(props: NestedFlowProps) {
  const { nodes, edges, onChange, onPaneContextMenu, onNodeContextMenu, nodeTypes } = props

  const [localNodes, setLocalNodes] = useState<AppNode[]>(nodes)
  const [localEdges, setLocalEdges] = useState<AppEdge[]>(edges)
  const nodesRef = useRef<AppNode[]>(nodes)
  const edgesRef = useRef<AppEdge[]>(edges)
  const onChangeRef = useRef(onChange)
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const { screenToFlowPosition } = useReactFlow()

  onChangeRef.current = onChange

  const currentGraph = useCallback(
    (): NestedFlowGraph => ({ nodes: nodesRef.current, edges: edgesRef.current }),
    [],
  )

  // Adopt the owner's graph into local state. Props are the store truth; the
  // owner re-renders from the store, so props are always at least as fresh as
  // local state by the time the next user event runs.
  const adopt = useCallback((nextNodes: AppNode[], nextEdges: AppEdge[]) => {
    nodesRef.current = nextNodes
    edgesRef.current = nextEdges
    setLocalNodes(nextNodes)
    setLocalEdges(nextEdges)
  }, [])

  const emit = useCallback(
    (force: boolean) => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (!force && !pendingRef.current) return
      pendingRef.current = false
      onChangeRef.current(currentGraph())
    },
    [currentGraph],
  )

  const scheduleChange = useCallback(() => {
    pendingRef.current = true
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => emit(true), DEBOUNCE_MS)
  }, [emit])

  // Flush any pending change when unmounting.
  useEffect(() => () => emit(true), [emit])

  // Controlled sync from props: only adopt when the content actually differs.
  useEffect(() => {
    if (nodes === nodesRef.current) return
    if (JSON.stringify(nodes) === JSON.stringify(nodesRef.current)) return
    if (pendingRef.current) return
    adopt(nodes, edges)
  }, [nodes, edges, adopt])

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setLocalNodes((prev) => {
        const next = applyNodeChanges(
          changes,
          prev as unknown as Node[],
        ) as unknown as AppNode[]
        nodesRef.current = next
        return next
      })
      scheduleChange()
    },
    [scheduleChange],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setLocalEdges((prev) => {
        const next = applyEdgeChanges(changes, prev)
        edgesRef.current = next
        return next
      })
      scheduleChange()
    },
    [scheduleChange],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      setLocalEdges((prev) => {
        const next = addEdge<AppEdge>({ ...connection, type: 'smoothstep' }, prev)
        edgesRef.current = next
        return next
      })
      scheduleChange()
    },
    [scheduleChange],
  )

  const closeMenu = useCallback(() => setMenu(null), [])

  const handlePaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      if (!onPaneContextMenu) return
      event.preventDefault()
      adopt(props.nodes, props.edges)
      emit(true)
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      setMenu({ items: onPaneContextMenu(position, currentGraph()), x: event.clientX, y: event.clientY })
    },
    [onPaneContextMenu, screenToFlowPosition, currentGraph, emit, adopt, props],
  )

  const handleNodeContextMenu = useCallback<NodeMouseHandler>(
    (event, node) => {
      if (!onNodeContextMenu) return
      event.preventDefault()
      adopt(props.nodes, props.edges)
      emit(true)
      setMenu({
        items: onNodeContextMenu(node as unknown as AppNode, currentGraph()),
        x: event.clientX,
        y: event.clientY,
      })
    },
    [onNodeContextMenu, currentGraph, emit, adopt, props],
  )

  const contextValue = useMemo<NestedFlowContextValue>(
    () => ({
      updateNodeData: (nodeId: string, patch: Record<string, unknown>) => {
        const next = nodesRef.current.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, ...patch } as unknown as AppNode['data'] }
            : n,
        )
        nodesRef.current = next
        setLocalNodes(next)
        emit(true)
      },
      updateEdgeLabel: (edgeId: string, label: string) => {
        const next = edgesRef.current.map((e) => (e.id === edgeId ? { ...e, label } : e))
        edgesRef.current = next
        setLocalEdges(next)
        emit(true)
      },
    }),
    [emit],
  )

  return (
    <NestedFlowContext.Provider value={contextValue}>
      <ReactFlow
        nodes={localNodes as unknown as Node[]}
        edges={localEdges as unknown as Edge[]}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={closeMenu}
        onNodeClick={closeMenu}
        colorMode="dark"
        deleteKeyCode={['Backspace', 'Delete']}
        zoomOnDoubleClick={false}
        panOnScroll
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        connectionMode={ConnectionMode.Loose}
        snapToGrid
        snapGrid={[10, 10]}
        minZoom={0.2}
        maxZoom={1.5}
        defaultEdgeOptions={{ type: 'smoothstep' }}
      />
      {menu && <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={closeMenu} />}
    </NestedFlowContext.Provider>
  )
}

export function NestedFlow(props: NestedFlowProps): ReactNode {
  return (
    <div
      className={props.className}
      data-subflow
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      style={{ width: '100%', height: '100%' }}
    >
      <ReactFlowProvider>
        <NestedFlowInner {...props} />
      </ReactFlowProvider>
    </div>
  )
}
