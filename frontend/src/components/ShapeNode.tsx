import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useGraphStore } from '../store'
import NodeSideHandles from './NodeSideHandles'
import { NodeMeta } from './NodeMeta'

function ShapeEditForm({ onDone }: { onDone: () => void }) {
  const draft = useGraphStore((s) => s.editDraft)
  const updateEditDraft = useGraphStore((s) => s.updateEditDraft)
  const cancelEditing = useGraphStore((s) => s.cancelEditing)

  const label = draft?.label ?? ''
  const items = draft?.items ?? []
  const path = draft?.path ?? ''
  const description = draft?.description ?? ''

  return (
    <div
      className="shape-edit"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="shape-edit__title">Edit shape</div>
      <input
        className="shape-edit__input"
        value={label}
        onChange={(e) => updateEditDraft({ label: e.target.value })}
        placeholder="label"
        autoFocus
      />
      <textarea
        className="shape-edit__items"
        value={items.join('\n')}
        onChange={(e) => updateEditDraft({ items: e.target.value.split('\n') })}
        placeholder={'one item per line\ne.g. GET /users\nPOST /users'}
        rows={Math.max(3, items.length + 1)}
      />
      <NodeMeta block="shape" path={path} description={description} onChange={updateEditDraft} />
      <div className="shape-edit__actions">
        <button onClick={onDone}>Save</button>
        <button onClick={() => cancelEditing()}>Cancel</button>
      </div>
    </div>
  )
}

function ShapeView({ id, kind }: { id: string; kind: 'rect' | 'circle' }) {
  const data = useGraphStore((s) => s.graphs[s.activeLayer].nodes.find((n) => n.id === id)?.data)
  const label = (data?.label as string | undefined) ?? kind
  const items = (data?.items as string[] | undefined) ?? []
  const path = (data?.path as string | undefined) ?? ''

  if (kind === 'circle') {
    return (
      <div className="shape-node__inner shape-node__inner--circle">
        <div className="shape-node__clabel">{label}</div>
        {path && <div className="node-meta__path">{path}</div>}
        {items.length > 0 && (
          <ul className="shape-node__items shape-node__items--circle">
            {items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="shape-node__inner">
      <div className="shape-node__header">{label}</div>
      {path && <div className="node-meta__path">{path}</div>}
      {items.length > 0 && (
        <ul className="shape-node__items">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ShapeNode({ id, data }: NodeProps) {
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const editingNodeId = useGraphStore((s) => s.editingNodeId)
  const setEditingNode = useGraphStore((s) => s.startEditing)
  const commitEditing = useGraphStore((s) => s.commitEditing)
  const updateNodeSize = useGraphStore((s) => s.updateNodeSize)

  const kind = (data as { kind?: string }).kind === 'circle' ? 'circle' : 'rect'
  const isEditing = editingNodeId === id

  return (
    <div
      className={`shape-node shape-node--${kind} ${isEditing ? 'shape-node--editing' : ''}`}
      onDoubleClick={() => !isEditing && setEditingNode(activeLayer, id)}
    >
      <NodeResizer
        minWidth={60}
        minHeight={60}
        color="#7a8bff"
        onResizeEnd={(_event, params) => updateNodeSize(activeLayer, id, params.width, params.height)}
      />
      <NodeSideHandles isConnectable={!isEditing} />
      {isEditing ? (
        <ShapeEditForm onDone={() => commitEditing(activeLayer)} />
      ) : (
        <ShapeView id={id} kind={kind} />
      )}
    </div>
  )
}

export default ShapeNode
