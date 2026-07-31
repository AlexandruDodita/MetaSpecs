import type { NodeProps } from '@xyflow/react'
import type { PreviewNodeData } from '../types'

export default function PreviewNode({ data }: NodeProps) {
  const kind = (data as PreviewNodeData).kind ?? 'rect'
  return (
    <div
      className={`preview preview--${kind === 'circle' ? 'circle' : 'rect'}`}
    />
  )
}
