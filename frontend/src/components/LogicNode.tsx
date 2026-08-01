import { useCallback, useEffect, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import type { LogicKind, LogicNodeData } from '../types'
import { Highlighted } from './Highlighted'
import { useNestedFlowContext } from './NestedFlow'

type LogicNodeProps = NodeProps<Node<LogicNodeData, 'logic'>>

function LogicLabel({ id, label }: { id: string; label: string }) {
  const ctx = useNestedFlowContext()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)

  useEffect(() => {
    setDraft(label)
  }, [label])

  const commit = useCallback(() => {
    if (!editing) return
    setEditing(false)
    ctx?.updateNodeData(id, { label: draft })
  }, [editing, ctx, id, draft])

  const cancel = useCallback(() => {
    setDraft(label)
    setEditing(false)
  }, [label])

  const startEdit = useCallback(() => {
    setDraft(label)
    setEditing(true)
  }, [label])

  if (editing) {
    return (
      <div
        className="logic-edit"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <textarea
          className="logic-edit__textarea"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') {
              cancel()
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            }
          }}
        />
        <div className="logic-edit__bar">
          <button
            className="logic-edit__btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={commit}
          >
            ok
          </button>
          <button
            className="logic-edit__btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancel}
          >
            ✕
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="logic-node__label"
      onDoubleClick={(e) => {
        e.stopPropagation()
        startEdit()
      }}
    >
      <Highlighted text={label} />
    </div>
  )
}

export function LogicNode({ id, data }: LogicNodeProps) {
  const kind: LogicKind = data?.kind ?? 'step'
  const label = data?.label ?? kind
  const isStart = kind === 'start'
  const isEnd = kind === 'end'

  return (
    <div className={`logic-node logic-node--${kind}`}>
      <div className="logic-node__shape" />
      {!isStart && <Handle type="target" position={Position.Left} className="logic-node__handle" />}
      {!isEnd && <Handle type="source" position={Position.Right} className="logic-node__handle" />}
      {kind === 'call' && <span className="logic-node__badge">call</span>}
      <div className="logic-node__content">
        <LogicLabel id={id} label={label} />
      </div>
    </div>
  )
}

export default LogicNode
