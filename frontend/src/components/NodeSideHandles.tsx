import { Handle, Position } from '@xyflow/react'

export default function NodeSideHandles({ isConnectable }: { isConnectable: boolean }) {
  return (
    <>
      <Handle
        id="top"
        type="source"
        position={Position.Top}
        className="node-handle"
        isConnectable={isConnectable}
      />
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        className="node-handle"
        isConnectable={isConnectable}
      />
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        className="node-handle"
        isConnectable={isConnectable}
      />
      <Handle
        id="left"
        type="source"
        position={Position.Left}
        className="node-handle"
        isConnectable={isConnectable}
      />
    </>
  )
}
