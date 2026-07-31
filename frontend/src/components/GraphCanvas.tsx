import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap } from '@xyflow/react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { useCallback, useEffect, useState } from 'react'
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
import type { Layer } from '../types'
import { useGraphStore, useLayerNodes, useLayerEdges } from '../store'
import { buildEdgeMenu, buildNodeMenu, buildPaneMenu } from '../menu/builders'
import { ContextMenu } from './ContextMenu'
import TableNode from './TableNode'

const nodeTypes = { table: TableNode }

interface MenuState {
  items: ReturnType<typeof buildPaneMenu>
  x: number
  y: number
}

function CanvasInner({ layer }: { layer: Layer }) {
  const nodes = useLayerNodes(layer)
  const edges = useLayerEdges(layer)
  const onNodesChange = useGraphStore((s) => s.onNodesChange)
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange)
  const onConnect = useGraphStore((s) => s.onConnect)
  const tool = useGraphStore((s) => s.tool)
  const wireSource = useGraphStore((s) => s.wireSource)
  const setWireSource = useGraphStore((s) => s.setWireSource)
  const connectNodes = useGraphStore((s) => s.connectNodes)
  const addNodeAt = useGraphStore((s) => s.addNodeAt)
  const setSelectedNodeIds = useGraphStore((s) => s.setSelectedNodeIds)
  const setTool = useGraphStore((s) => s.setTool)
  const commitEditing = useGraphStore((s) => s.commitEditing)
  const { screenToFlowPosition } = useReactFlow()

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

  const handlePaneClick = useCallback(
    (event: ReactMouseEvent) => {
      closeMenu()
      commitEditing(layer)
      if (tool === 'table') {
        const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
        addNodeAt(layer, {
          id: `n-${Date.now()}`,
          type: 'table',
          position,
          data: {
            label: 'table',
            columns: [{ name: 'id', type: 'uuid', constraint: 'PRIMARY KEY' }],
          },
        })
      } else if (tool === 'wire' && wireSource) {
        setWireSource(null)
      }
    },
    [closeMenu, commitEditing, tool, wireSource, layer, screenToFlowPosition, addNodeAt, setWireSource],
  )

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
      if (tool === 'wire') return
      useGraphStore.getState().startEditing(layer, node.id)
    },
    [layer, tool],
  )

  const handleKeyDown = useCallback(
    (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu()
        if (wireSource) setWireSource(null)
      }
    },
    [closeMenu, wireSource, setWireSource],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes as unknown as Node[]}
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
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
      {menu && <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={closeMenu} />}
      {tool === 'wire' && (
        <div className="canvas__hint">
          {wireSource ? 'Click a target table to wire it' : 'Click a source table'}
          <button onClick={() => setTool('select')}>cancel</button>
        </div>
      )}
      {tool === 'table' && (
        <div className="canvas__hint">
          Click the canvas to place a table
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
