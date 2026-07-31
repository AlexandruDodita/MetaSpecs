import { ReactFlow, Background, Controls, MiniMap } from '@xyflow/react'
import { useCallback } from 'react'
import type {
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { AppEdge, Layer } from '../types'
import { useGraphStore, useLayerNodes, useLayerEdges } from '../store'
import TableNode from './TableNode'

const nodeTypes = { table: TableNode }

export function GraphCanvas({ layer }: { layer: Layer }) {
  const nodes = useLayerNodes(layer)
  const edges = useLayerEdges(layer)
  const onNodesChange = useGraphStore((s) => s.onNodesChange)
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange)
  const onConnect = useGraphStore((s) => s.onConnect)

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
        id: `e-${Date.now()}`,
        source: connection.source,
        target: connection.target,
        label: '',
      } as AppEdge),
    [layer, onConnect],
  )

  return (
    <ReactFlow
      nodes={nodes as unknown as Node[]}
      edges={edges as unknown as Edge[]}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onConnect={handleConnect}
      fitView
    >
      <Background />
      <Controls />
      <MiniMap />
    </ReactFlow>
  )
}
