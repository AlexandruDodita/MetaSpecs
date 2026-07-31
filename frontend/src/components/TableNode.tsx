import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { Column } from '../types'
import { useGraphStore } from '../store'

function TableNode({ id }: NodeProps) {
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const data = useGraphStore((s) => s.graphs[s.activeLayer].nodes.find((n) => n.id === id)?.data)
  const updateNodeData = useGraphStore((s) => s.updateNodeData)

  const columns: Column[] = (data?.columns as Column[] | undefined) ?? []
  const label = (data?.label as string | undefined) ?? 'table'

  const setLabel = (value: string) => updateNodeData(activeLayer, id, { label: value })

  const setColumn = (index: number, field: keyof Column, value: string) => {
    const next = columns.map((col, i) => (i === index ? { ...col, [field]: value } : col))
    updateNodeData(activeLayer, id, { columns: next })
  }

  const addColumn = () =>
    updateNodeData(activeLayer, id, {
      columns: [...columns, { name: '', type: 'text', constraint: '' }],
    })

  const removeColumn = (index: number) =>
    updateNodeData(activeLayer, id, {
      columns: columns.filter((_, i) => i !== index),
    })

  return (
    <div className="table-node">
      <Handle type="target" position={Position.Top} />
      <input
        className="table-node__label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="table name"
      />
      <table className="table-node__grid">
        <thead>
          <tr>
            <th>name</th>
            <th>type</th>
            <th>constraint</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {columns.map((col, i) => (
            <tr key={i}>
              <td>
                <input
                  value={col.name}
                  onChange={(e) => setColumn(i, 'name', e.target.value)}
                  placeholder="col"
                />
              </td>
              <td>
                <input
                  value={col.type}
                  onChange={(e) => setColumn(i, 'type', e.target.value)}
                  placeholder="type"
                />
              </td>
              <td>
                <input
                  value={col.constraint}
                  onChange={(e) => setColumn(i, 'constraint', e.target.value)}
                  placeholder="constraint"
                />
              </td>
              <td>
                <button className="table-node__del" onClick={() => removeColumn(i)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="table-node__add" onClick={addColumn}>
        + column
      </button>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export default TableNode
