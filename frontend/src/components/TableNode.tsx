import { Handle, NodeResizer, Position } from '@xyflow/react'
import { useUpdateNodeInternals } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { Column } from '../types'
import { useGraphStore } from '../store'
import { COLUMN_TYPES, CONSTRAINTS } from '../schema-options'

function TypeSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const known = COLUMN_TYPES.includes(value)
  return (
    <select className="table-edit__select" value={known ? value : '__custom'} onChange={(e) => onChange(e.target.value === '__custom' ? value : e.target.value)}>
      {COLUMN_TYPES.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
      <option value="__custom">custom…</option>
    </select>
  )
}

function ConstraintSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const known = CONSTRAINTS.includes(value)
  return (
    <select
      className="table-edit__select"
      value={known ? value : '__custom'}
      onChange={(e) => onChange(e.target.value === '__custom' ? value : e.target.value)}
    >
      <option value="">—</option>
      {CONSTRAINTS.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
      <option value="__custom">custom…</option>
    </select>
  )
}

function EditForm({ id, onDone }: { id: string; onDone: () => void }) {
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const data = useGraphStore((s) =>
    s.graphs[s.activeLayer].nodes.find((n) => n.id === id)?.data,
  )
  const updateNodeData = useGraphStore((s) => s.updateNodeData)
  const cancelEditing = useGraphStore((s) => s.cancelEditing)
  const updateNodeInternals = useUpdateNodeInternals()

  const columns = (data?.columns as Column[] | undefined) ?? []
  const label = (data?.label as string | undefined) ?? ''

  const setLabel = (value: string) => updateNodeData(activeLayer, id, { label: value })

  const setColumn = (index: number, field: keyof Column, value: string) => {
    const next = columns.map((col, i) => (i === index ? { ...col, [field]: value } : col))
    updateNodeData(activeLayer, id, { columns: next })
    updateNodeInternals(id)
  }

  const addColumn = () => {
    updateNodeData(activeLayer, id, {
      columns: [...columns, { name: '', type: 'varchar', constraint: '' }],
    })
    updateNodeInternals(id)
  }

  const removeColumn = (index: number) => {
    updateNodeData(activeLayer, id, { columns: columns.filter((_, i) => i !== index) })
    updateNodeInternals(id)
  }

  return (
    <div
      className="table-edit"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="table-edit__title">Edit table</div>
      <input
        className="table-edit__name"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="table name"
        autoFocus
      />
      {columns.map((col, i) => (
        <div key={i} className="table-edit__row">
          <input
            className="table-edit__input"
            value={col.name}
            onChange={(e) => setColumn(i, 'name', e.target.value)}
            placeholder="column"
          />
          <TypeSelect value={col.type} onChange={(v) => setColumn(i, 'type', v)} />
          {!COLUMN_TYPES.includes(col.type) && (
            <input
              className="table-edit__input table-edit__custom"
              value={col.type}
              onChange={(e) => setColumn(i, 'type', e.target.value)}
              placeholder="type"
            />
          )}
          <ConstraintSelect
            value={col.constraint}
            onChange={(v) => setColumn(i, 'constraint', v)}
          />
          {!CONSTRAINTS.includes(col.constraint) && col.constraint !== '' && (
            <input
              className="table-edit__input table-edit__custom"
              value={col.constraint}
              onChange={(e) => setColumn(i, 'constraint', e.target.value)}
              placeholder="constraint"
            />
          )}
          <button className="table-edit__del" onClick={() => removeColumn(i)}>
            ×
          </button>
        </div>
      ))}
      <button className="table-edit__add" onClick={addColumn}>
        + column
      </button>
      <div className="table-edit__actions">
        <button onClick={onDone}>Save</button>
        <button onClick={() => cancelEditing(activeLayer)}>Cancel</button>
      </div>
    </div>
  )
}

function SchemaView({ id }: { id: string }) {
  const data = useGraphStore((s) => s.graphs[s.activeLayer].nodes.find((n) => n.id === id)?.data)
  const isEditing = useGraphStore((s) => s.editingNodeId)
  const columns = (data?.columns as Column[] | undefined) ?? []
  const label = (data?.label as string | undefined) ?? 'table'

  return (
    <>
      <div className="schema">
        <div className="schema__header">
          <span className="schema__name">{label}</span>
          <span className="schema__badge">TABLE</span>
        </div>
        <table className="schema__grid">
          <thead>
            <tr>
              <th className="schema__col-name">column</th>
              <th className="schema__col-type">type</th>
              <th className="schema__col-constraint">constraint</th>
            </tr>
          </thead>
          <tbody>
            {columns.length === 0 && (
              <tr>
                <td colSpan={3} className="schema__empty">
                  no columns
                </td>
              </tr>
            )}
            {columns.map((col, i) => (
              <tr key={i} className="schema__row">
                <td className="schema__col-name">
                  {col.constraint.includes('PRIMARY') && (
                    <span className="schema__key" title="primary key">
                      🔑
                    </span>
                  )}
                  <Handle
                    id={col.name || `col-${i}`}
                    type="target"
                    position={Position.Left}
                    className="schema__handle"
                    isConnectable={!isEditing}
                  />
                  {col.name || <span className="schema__empty">(unnamed)</span>}
                </td>
                <td className="schema__col-type">
                  <Handle
                    id={col.name || `col-${i}`}
                    type="source"
                    position={Position.Right}
                    className="schema__handle"
                    isConnectable={!isEditing}
                  />
                  {col.type || '—'}
                </td>
                <td className="schema__col-constraint">
                  {col.constraint ? (
                    <span className={`schema__tag ${col.constraint.includes('PRIMARY') ? 'schema__tag--pk' : ''}`}>
                      {col.constraint}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function TableNode({ id }: NodeProps) {
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const editingNodeId = useGraphStore((s) => s.editingNodeId)
  const setEditingNode = useGraphStore((s) => s.startEditing)
  const commitEditing = useGraphStore((s) => s.commitEditing)
  const updateNodeSize = useGraphStore((s) => s.updateNodeSize)

  const isEditing = editingNodeId === id

  return (
    <div
      className={`table-node ${isEditing ? 'table-node--editing' : ''}`}
      onDoubleClick={() => !isEditing && setEditingNode(activeLayer, id)}
    >
      <NodeResizer
        minWidth={260}
        minHeight={120}
        color="#7a8bff"
        onResizeEnd={(_event, params) => updateNodeSize(activeLayer, id, params.width, params.height)}
      />
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        className="schema__handle schema__handle--table"
        isConnectable={!isEditing}
      />
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="schema__handle schema__handle--table"
        isConnectable={!isEditing}
      />
      {isEditing ? (
        <EditForm id={id} onDone={() => commitEditing(activeLayer)} />
      ) : (
        <SchemaView id={id} />
      )}
    </div>
  )
}

export default TableNode
