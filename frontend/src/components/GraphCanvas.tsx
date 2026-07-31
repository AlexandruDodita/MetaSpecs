import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap } from '@xyflow/react'
import { ReactFlowProvider, useReactFlow, useStoreApi } from '@xyflow/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  Connection,
  NodeMouseHandler,
} from '@xyflow/react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import '@xyflow/react/dist/style.css'
import type { AppNode, Layer } from '../types'
import { useGraphStore, useLayerNodes, useLayerEdges } from '../store'
import type { PlaceableTool } from '../store'
import { buildEdgeMenu, buildNodeMenu, buildPaneMenu } from '../menu/builders'
import { ContextMenu } from './ContextMenu'
import TableNode from './TableNode'
import ShapeNode from './ShapeNode'
import PreviewNode from './PreviewNode'
import { makeNode } from '../nodeFactory'

const nodeTypes = { table: TableNode, shape: ShapeNode, preview: PreviewNode }

const PLACEMENT_TOOLS: ReadonlySet<PlaceableTool> = new Set(['rect', 'circle', 'table'])

interface MenuState {
  items: ReturnType<typeof buildPaneMenu>
  x: number
  y: number
}

const TOOL_HINT: Record<PlaceableTool, string> = {
  rect: 'Drag on the canvas to draw a rectangle',
  circle: 'Drag on the canvas to draw a circle',
  table: 'Drag on the canvas to draw a table',
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true
  }
  return el.isContentEditable
}

function CanvasInner({ layer }: { layer: Layer }) {
  const nodes = useLayerNodes(layer)
  const edges = useLayerEdges(layer)
  const onNodesChange = useGraphStore((s) => s.onNodesChange)
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange)
  const onConnect = useGraphStore((s) => s.onConnect)
  const tool = useGraphStore((s) => s.tool)
  const wireSource = useGraphStore((s) => s.wireSource)
  const drawing = useGraphStore((s) => s.drawing)
  const setWireSource = useGraphStore((s) => s.setWireSource)
  const connectNodes = useGraphStore((s) => s.connectNodes)
  const addNodeAt = useGraphStore((s) => s.addNodeAt)
  const setSelectedNodeIds = useGraphStore((s) => s.setSelectedNodeIds)
  const setTool = useGraphStore((s) => s.setTool)
  const commitEditing = useGraphStore((s) => s.commitEditing)
  const startDrawing = useGraphStore((s) => s.startDrawing)
  const updateDrawing = useGraphStore((s) => s.updateDrawing)
  const { screenToFlowPosition, fitView } = useReactFlow()
  const storeApi = useStoreApi()
  const fittedRef = useRef(false)
  const dirty = useGraphStore((s) => s.dirty[layer])

  useEffect(() => {
    fittedRef.current = false
  }, [layer])

  useEffect(() => {
    if (nodes.length === 0 || fittedRef.current || dirty) return
    fittedRef.current = true
    const timer = window.setTimeout(() => void fitView({ padding: 0.2 }), 0)
    return () => window.clearTimeout(timer)
  }, [nodes.length, fitView, dirty])

  const [menu, setMenu] = useState<MenuState | null>(null)

  const closeMenu = useCallback(() => setMenu(null), [])

  const openMenuAt = useCallback(
    (event: ReactMouseEvent, items: MenuState['items']) => {
      event.preventDefault()
      event.stopPropagation()
      setMenu({ items, x: event.clientX, y: event.clientY })
    },
    [],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => onNodesChange(layer, changes),
    [layer, onNodesChange],
  )
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => onEdgesChange(layer, changes),
    [layer, onEdgesChange],
  )
  const handleConnect = useCallback(
    (connection: Connection) =>
      onConnect(layer, {
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      }),
    [layer, onConnect],
  )

  const handleNodeClick = useCallback<NodeMouseHandler>(
    (_, node) => {
      if (PLACEMENT_TOOLS.has(tool as PlaceableTool)) return
      if (tool === 'wire') {
        if (!wireSource) {
          setWireSource(node.id)
        } else if (wireSource !== node.id) {
          connectNodes(layer, wireSource, node.id)
          setWireSource(null)
          setTool('select')
        }
        return
      }
      commitEditing(layer)
      setSelectedNodeIds([node.id])
    },
    [tool, wireSource, layer, connectNodes, setWireSource, setTool, commitEditing, setSelectedNodeIds],
  )

  useEffect(() => {
    if (!PLACEMENT_TOOLS.has(tool as PlaceableTool)) return
    const pane = storeApi
      .getState()
      .domNode?.querySelector('.react-flow__pane') as HTMLDivElement | null
    if (!pane) return
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (event.button !== 0) return
      closeMenu()
      commitEditing(layer)
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      startDrawing(tool as PlaceableTool, position.x, position.y)
    }
    pane.addEventListener('mousedown', onMouseDown)
    return () => pane.removeEventListener('mousedown', onMouseDown)
  }, [tool, storeApi, closeMenu, commitEditing, layer, screenToFlowPosition, startDrawing])

  const handlePaneClick = useCallback(() => {
    closeMenu()
    commitEditing(layer)
    if (tool === 'wire' && wireSource) {
      setWireSource(null)
    }
  }, [closeMenu, commitEditing, layer, tool, wireSource, setWireSource])

  const buildDrawNode = useCallback(
    (drawing: ReturnType<typeof useGraphStore.getState>['drawing']) => {
      if (!drawing) return null
      const kind = drawing.kind === 'table' ? 'table' : drawing.kind
      const previewNode: AppNode = {
        id: '__draw__',
        type: 'preview',
        position: { x: drawing.x, y: drawing.y },
        style: { width: Math.max(drawing.w, 1), height: Math.max(drawing.h, 1) },
        data: { kind },
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
      }
      return previewNode
    },
    [],
  )
  const drawNode = buildDrawNode(drawing)
  const isDrawing = drawing !== null

  useEffect(() => {
    if (!isDrawing) return
    const handleMove = (event: globalThis.MouseEvent) => {
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      updateDrawing(position.x, position.y)
    }
    const handleUp = () => {
      const state = useGraphStore.getState()
      const d = state.drawing
      if (d && Math.abs(d.w) >= 8 && Math.abs(d.h) >= 8) {
        state.addNodeAt(
          layer,
          makeNode(d.kind, d.x, d.y, Math.abs(d.w), Math.abs(d.h)),
        )
      }
      state.finishDrawing()
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [isDrawing, layer, screenToFlowPosition, updateDrawing, addNodeAt])

  const handlePaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      event.preventDefault()
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      openMenuAt(event as unknown as ReactMouseEvent, buildPaneMenu({ layer, x: position.x, y: position.y }))
    },
    [openMenuAt, layer, screenToFlowPosition],
  )

  const handleNodeContextMenu = useCallback<NodeMouseHandler>(
    (event, node) => {
      if (tool === 'wire') {
        handleNodeClick(event, node)
        return
      }
      openMenuAt(event, buildNodeMenu({ layer, x: 0, y: 0 }, node.id))
    },
    [openMenuAt, layer, tool, handleNodeClick],
  )

  const handleEdgeContextMenu = useCallback(
    (event: ReactMouseEvent, edge: { id: string }) => {
      openMenuAt(event, buildEdgeMenu({ layer, x: 0, y: 0 }, edge.id))
    },
    [openMenuAt, layer],
  )

  const handleSelectionChange = useCallback(
    ({ nodes }: { nodes: { id: string }[] }) => {
      setSelectedNodeIds(nodes.map((n) => n.id))
    },
    [setSelectedNodeIds],
  )

  const handleNodeDoubleClick = useCallback<NodeMouseHandler>(
    (_, node) => {
      if (tool !== 'select') return
      useGraphStore.getState().startEditing(layer, node.id)
    },
    [layer, tool],
  )

  const handleKeyDown = useCallback(
    (event: globalThis.KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'escape') {
        closeMenu()
        if (useGraphStore.getState().drawing) useGraphStore.getState().finishDrawing()
        if (wireSource) setWireSource(null)
        return
      }
      const toolByKey: Record<string, PlaceableTool | 'select' | 'wire'> = {
        v: 'select',
        r: 'rect',
        c: 'circle',
        t: 'table',
        w: 'wire',
      }
      const next = toolByKey[key]
      if (next && next !== tool) setTool(next)
    },
    [closeMenu, wireSource, setWireSource, tool, setTool],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const renderNodes = (
    drawNode ? [...nodes, drawNode] : nodes
  ) as unknown as Node[]

  return (
    <div className="canvas">
      <ReactFlow
        nodes={renderNodes}
        edges={edges as unknown as Edge[]}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onPaneClick={handlePaneClick}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        onEdgeContextMenu={handleEdgeContextMenu}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onSelectionChange={handleSelectionChange}
        colorMode="dark"
        deleteKeyCode={['Backspace', 'Delete']}
        connectionRadius={24}
        panOnDrag={tool === 'select' || tool === 'wire'}
        panOnScroll
        selectionOnDrag={tool === 'select'}
        zoomOnDoubleClick={tool === 'select'}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
      {menu && <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={closeMenu} />}
      {drawing && tool !== 'select' && (
        <div className="canvas__hint">
          {Math.round(drawing.w)} × {Math.round(drawing.h)}
        </div>
      )}
      {tool === 'wire' && (
        <div className="canvas__hint">
          {wireSource ? 'Click a target node to wire it' : 'Click a source node'}
          <button onClick={() => setTool('select')}>cancel</button>
        </div>
      )}
      {PLACEMENT_TOOLS.has(tool as PlaceableTool) && !drawing && (
        <div className="canvas__hint">
          {TOOL_HINT[tool as PlaceableTool]}
          <button onClick={() => setTool('select')}>cancel</button>
        </div>
      )}
    </div>
  )
}

export function GraphCanvas({ layer }: { layer: Layer }) {
  return (
    <ReactFlowProvider>
      <CanvasInner layer={layer} />
    </ReactFlowProvider>
  )
}
