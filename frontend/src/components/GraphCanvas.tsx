import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ViewportPortal,
  ConnectionMode,
  getSmoothStepPath,
  Position,
} from '@xyflow/react'
import { ReactFlowProvider, useReactFlow, useStoreApi } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  Connection,
  NodeMouseHandler,
} from '@xyflow/react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import '@xyflow/react/dist/style.css'
import type { AppNode, EdgeKind, Layer } from '../types'
import { useGraphStore, useLayerNodes, useLayerEdges, isExpanded } from '../store'
import type { PlaceableTool } from '../store'
import { buildEdgeMenu, buildNodeMenu, buildPaneMenu } from '../menu/builders'
import { ContextMenu } from './ContextMenu'
import TableNode from './TableNode'
import ShapeNode from './ShapeNode'
import ClassNode from './ClassNode'
import ServiceNode from './ServiceNode'
import FileNode from './FileNode'
import PreviewNode from './PreviewNode'
import { makeNode, type PlaceableKind } from '../nodeFactory'
import { closestSides, nodeSizeOf, pointNode, sideAnchor, type Side } from '../geometry'

const nodeTypes = {
  table: TableNode,
  shape: ShapeNode,
  class: ClassNode,
  service: ServiceNode,
  file: FileNode,
  preview: PreviewNode,
}

const EDGE_STROKE: Record<EdgeKind, string> = {
  contains: '#8b8f9a',
  calls: '#7a8bff',
  implements: '#4fd18b',
  reads: '#e0b155',
  writes: '#e07a7a',
  'depends-on': '#7a8bff',
}

const PLACEMENT_TOOLS: ReadonlySet<PlaceableTool> = new Set([
  'rect',
  'circle',
  'table',
  'class',
  'service',
  'file',
])

const WIRE_SNAP_RADIUS = 140

const SIDE_POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

function nearestSnapNode(
  nodes: AppNode[],
  pointer: { x: number; y: number },
  excludeId: string | null,
): string | null {
  let best: string | null = null
  let bestDist = WIRE_SNAP_RADIUS
  for (const node of nodes) {
    if (node.id === excludeId) continue
    const { width, height } = nodeSizeOf(node)
    const dx = Math.max(node.position.x - pointer.x, 0, pointer.x - (node.position.x + width))
    const dy = Math.max(node.position.y - pointer.y, 0, pointer.y - (node.position.y + height))
    const dist = Math.hypot(dx, dy)
    if (dist <= bestDist) {
      bestDist = dist
      best = node.id
    }
  }
  return best
}

interface MenuState {
  items: ReturnType<typeof buildPaneMenu>
  x: number
  y: number
}

const TOOL_HINT: Record<PlaceableTool, string> = {
  rect: 'Drag on the canvas to draw a rectangle',
  circle: 'Drag on the canvas to draw a circle',
  table: 'Drag on the canvas to draw a table',
  class: 'Drag on the canvas to draw a class',
  service: 'Drag on the canvas to draw a service',
  file: 'Drag on the canvas to draw a file',
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
  const expanded = useGraphStore((s) => s.expanded)
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
  const setSelectedEdgeIds = useGraphStore((s) => s.setSelectedEdgeIds)
  const deleteSelection = useGraphStore((s) => s.deleteSelection)
  const setTool = useGraphStore((s) => s.setTool)
  const commitEditing = useGraphStore((s) => s.commitEditing)
  const cancelEditing = useGraphStore((s) => s.cancelEditing)
  const startDrawing = useGraphStore((s) => s.startDrawing)
  const updateDrawing = useGraphStore((s) => s.updateDrawing)
  const undo = useGraphStore((s) => s.undo)
  const redo = useGraphStore((s) => s.redo)
  const { screenToFlowPosition, fitView } = useReactFlow()
  const storeApi = useStoreApi()
  const loadSeq = useGraphStore((s) => s.loadSeq)
  const fittedKeyRef = useRef('')

  // Tree hiding: a node wired to a container (service for files, service or
  // file for classes) is hidden from the canvas while every connected
  // container is collapsed — it lives inside the container's tree instead.
  // Edges touching hidden nodes are hidden too. Visibility is computed
  // bottom-up: a file whose services are all collapsed is itself hidden, and
  // its classes then count it as a hidden (not expanded) container.
  const { renderNodes, renderEdges } = useMemo(() => {
    const serviceIds = new Set(
      nodes.filter((n) => n.type === 'service').map((n) => n.id),
    )
    const fileIds = new Set(
      nodes.filter((n) => n.type === 'file').map((n) => n.id),
    )
    const connectedIds = (nodeId: string) =>
      edges
        .filter((e) => e.source === nodeId || e.target === nodeId)
        .map((e) => (e.source === nodeId ? e.target : e.source))
    const hidden = new Set<string>()
    const fileHidden = (fid: string): boolean => {
      const services = connectedIds(fid).filter((id) => serviceIds.has(id))
      return (
        services.length > 0 &&
        !services.some((sid) => isExpanded(expanded, sid, 'service'))
      )
    }
    for (const n of nodes) {
      if (n.type === 'file' && fileHidden(n.id)) hidden.add(n.id)
    }
    for (const n of nodes) {
      if (n.type !== 'class') continue
      const containers = connectedIds(n.id).filter(
        (id) => serviceIds.has(id) || fileIds.has(id),
      )
      const expandedContainer =
        containers.some((id) =>
          serviceIds.has(id)
            ? isExpanded(expanded, id, 'service')
            : isExpanded(expanded, id, 'file') && !hidden.has(id),
        )
      if (containers.length > 0 && !expandedContainer) hidden.add(n.id)
    }
    const renderNodes = nodes.filter((n) => !hidden.has(n.id))
    const renderEdges = edges
      .filter((e) => !hidden.has(e.source) && !hidden.has(e.target))
      .map((e) => ({
        ...e,
        style: { ...e.style, stroke: EDGE_STROKE[e.kind ?? 'depends-on'] },
      }))
    return { renderNodes, renderEdges }
  }, [nodes, edges, expanded])

  useEffect(() => {
    const fittedKey = `${layer}:${loadSeq}`
    if (fittedKeyRef.current === fittedKey) return
    fittedKeyRef.current = fittedKey
    if (nodes.length === 0) return
    const timer = window.setTimeout(() => void fitView({ padding: 0.2 }), 0)
    return () => window.clearTimeout(timer)
  }, [nodes.length, fitView, layer, loadSeq])

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [wirePointer, setWirePointer] = useState<{ x: number; y: number } | null>(null)

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

  const finishWiring = useCallback(
    (targetId: string) => {
      if (!wireSource || wireSource === targetId) return
      connectNodes(layer, wireSource, targetId)
      setWireSource(null)
      setTool('select')
    },
    [wireSource, layer, connectNodes, setWireSource, setTool],
  )

  const handleNodeClick = useCallback<NodeMouseHandler>(
    (_, node) => {
      if (PLACEMENT_TOOLS.has(tool as PlaceableTool)) return
      if (tool === 'wire') {
        if (!wireSource) {
          setWireSource(node.id)
        } else {
          finishWiring(node.id)
        }
        return
      }
      commitEditing(layer)
      setSelectedNodeIds([node.id])
    },
    [tool, wireSource, setWireSource, layer, finishWiring, commitEditing, setSelectedNodeIds],
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

  const handlePaneClick = useCallback(
    (event: ReactMouseEvent) => {
      closeMenu()
      commitEditing(layer)
      if (tool !== 'wire') return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const targetId = nearestSnapNode(renderNodes, position, wireSource)
      if (!wireSource) {
        if (targetId) setWireSource(targetId)
        return
      }
      if (targetId) {
        finishWiring(targetId)
      } else {
        setWireSource(null)
      }
    },
    [closeMenu, commitEditing, layer, tool, wireSource, renderNodes, screenToFlowPosition, setWireSource, finishWiring],
  )

  const buildDrawNode = useCallback(
    (drawing: ReturnType<typeof useGraphStore.getState>['drawing']) => {
      if (!drawing) return null
      const kind: PlaceableKind = drawing.kind
      // Preview tracks the raw drag rect (clamping happens on drop in
      // makeNode), so class/service ghosts don't jump to their min size.
      const width = Math.max(drawing.w, 1)
      const height = Math.max(drawing.h, 1)
      const previewNode: AppNode = {
        id: '__draw__',
        type: 'preview',
        position: { x: drawing.x, y: drawing.y },
        width,
        height,
        style: { width, height },
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

  useEffect(() => {
    if (tool !== 'wire') {
      setWirePointer(null)
      return
    }
    const handleMove = (event: globalThis.MouseEvent) => {
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      setWirePointer({ x: position.x, y: position.y })
    }
    window.addEventListener('mousemove', handleMove)
    return () => window.removeEventListener('mousemove', handleMove)
  }, [tool, screenToFlowPosition])

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
    ({ nodes, edges }: { nodes: { id: string }[]; edges: { id: string }[] }) => {
      setSelectedNodeIds(nodes.map((n) => n.id))
      setSelectedEdgeIds(edges.map((e) => e.id))
    },
    [setSelectedNodeIds, setSelectedEdgeIds],
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
      if (event.ctrlKey || event.metaKey) {
        if (isEditableTarget(event.target)) return
        const k = event.key.toLowerCase()
        if (k === 'z' && !event.shiftKey) {
          event.preventDefault()
          undo(layer)
          return
        }
        if ((k === 'z' && event.shiftKey) || k === 'y') {
          event.preventDefault()
          redo(layer)
          return
        }
        return
      }
      if (event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'escape') {
        if (useGraphStore.getState().editingNodeId) {
          cancelEditing()
          return
        }
        closeMenu()
        if (useGraphStore.getState().drawing) useGraphStore.getState().finishDrawing()
        if (wireSource) setWireSource(null)
        return
      }
      if (isEditableTarget(event.target)) return
      if (key === 'delete' || key === 'backspace') {
        event.preventDefault()
        deleteSelection(layer)
        return
      }
      const toolByKey: Record<string, PlaceableTool | 'select' | 'wire'> = {
        v: 'select',
        r: 'rect',
        c: 'circle',
        t: 'table',
        k: 'class',
        s: 'service',
        f: 'file',
        w: 'wire',
      }
      const next = toolByKey[key]
      if (next && next !== tool) setTool(next)
    },
    [cancelEditing, closeMenu, wireSource, setWireSource, tool, setTool, undo, redo, layer, deleteSelection],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const renderNodesWithPreview = (
    drawNode ? [...renderNodes, drawNode] : renderNodes
  ) as unknown as Node[]

  let wireOverlay: ReactNode = null
  if (tool === 'wire' && wireSource && wirePointer) {
    const sourceNode = renderNodes.find((n) => n.id === wireSource)
    if (sourceNode) {
      const snapId = nearestSnapNode(renderNodes, wirePointer, wireSource)
      const snapNode = snapId ? (renderNodes.find((n) => n.id === snapId) ?? null) : null
      const farEnd = snapNode ?? pointNode(wirePointer)
      const { sourceSide, targetSide } = closestSides(sourceNode, farEnd)
      const sourceEnd = sideAnchor(sourceNode, sourceSide)
      const targetEnd = snapNode ? sideAnchor(snapNode, targetSide) : wirePointer
      let ring: ReactNode = null
      if (snapNode) {
        const { width: tw, height: th } = nodeSizeOf(snapNode)
        ring = (
          <rect
            className="wire-preview__ring"
            x={snapNode.position.x}
            y={snapNode.position.y}
            width={tw}
            height={th}
            rx={4}
          />
        )
      }
      const [path] = getSmoothStepPath({
        sourceX: sourceEnd.x,
        sourceY: sourceEnd.y,
        sourcePosition: SIDE_POSITION[sourceSide],
        targetX: targetEnd.x,
        targetY: targetEnd.y,
        targetPosition: SIDE_POSITION[targetSide],
        borderRadius: 8,
      })
      wireOverlay = (
        <ViewportPortal>
          <svg
            className="wire-preview"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 0,
              height: 0,
              overflow: 'visible',
              pointerEvents: 'none',
            }}
          >
            {ring}
            <path
              className={`wire-preview__line${snapNode ? ' wire-preview__line--snapped' : ''}`}
              d={path}
            />
          </svg>
        </ViewportPortal>
      )
    }
  }

  return (
    <div className="canvas">
      <ReactFlow
        nodes={renderNodesWithPreview}
        edges={renderEdges as unknown as Edge[]}
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
        connectionMode={ConnectionMode.Loose}
        deleteKeyCode={null}
        connectionRadius={24}
        panOnDrag={tool === 'select' || tool === 'wire'}
        panOnScroll
        selectionOnDrag={tool === 'select'}
        snapToGrid
        snapGrid={[10, 10]}
        zoomOnDoubleClick={tool === 'select'}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
        {wireOverlay}
      </ReactFlow>
      {menu && <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={closeMenu} />}
      {drawing && tool !== 'select' && (
        <div className="canvas__hint">
          {Math.round(drawing.w)} × {Math.round(drawing.h)}
        </div>
      )}
      {tool === 'wire' && (
        <div className="canvas__hint">
          {wireSource
            ? 'Move near a node to snap · click to connect · Esc to cancel'
            : 'Click a source node'}
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
