import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { Node } from '@xyflow/react'
import type { ClassNodeData, ServiceNodeData } from '../types'
import { useGraphStore } from '../store'
import { NestedFlow } from './NestedFlow'
import { buildServiceFlowPaneMenu } from '../menu/builders'
import NodeSideHandles from './NodeSideHandles'
import ClassNode from './ClassNode'

function ServiceEditForm({
  label,
  onLabel,
  onSave,
  onCancel,
}: {
  label: string
  onLabel: (label: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="service-edit"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="service-edit__title">Edit service</div>
      <input
        className="service-edit__name"
        value={label}
        onChange={(e) => onLabel(e.target.value)}
        placeholder="service name"
        autoFocus
      />
      <div className="service-edit__actions">
        <button onClick={onSave}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function ServiceView({ id, data }: { id: string; data: ServiceNodeData }) {
  const expanded = useGraphStore((s) => s.expanded[id])
  const toggleExpanded = useGraphStore((s) => s.toggleExpanded)
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const saveServiceFlow = useGraphStore((s) => s.saveServiceFlow)

  const label = data.label ?? 'service'
  const flow = data.flow ?? { nodes: [], edges: [] }
  const classCount = flow.nodes.filter((n) => n.type === 'class').length
  const flowCount = flow.nodes.reduce((sum, n) => {
    if (n.type !== 'class') return sum
    return sum + ((n.data as ClassNodeData).methods?.length ?? 0)
  }, 0)

  return (
    <>
      <div className="service-node__header">
        <span className="service-node__name">{label}</span>
        <span className="service-node__badge">SERVICE</span>
        <button
          className="service-node__toggle"
          title={expanded ? 'Collapse service' : 'Expand service'}
          onClick={(e) => {
            e.stopPropagation()
            toggleExpanded(id)
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>
      {expanded ? (
        <div className="service-node__body">
          <NestedFlow
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={{ class: ClassNode }}
            className="subflow subflow--service"
            onChange={(g) => saveServiceFlow(activeLayer, id, g)}
            onPaneContextMenu={(position, graph) =>
              buildServiceFlowPaneMenu({
                layer: activeLayer,
                x: position.x,
                y: position.y,
                graph,
                onCommit: (g) => saveServiceFlow(activeLayer, id, g),
              })
            }
          />
        </div>
      ) : (
        <div className="service-node__summary">
          {classCount} class{classCount === 1 ? '' : 'es'} · {flowCount} flow
          {flowCount === 1 ? '' : 's'}
        </div>
      )}
    </>
  )
}

function ServiceNode({ id, data }: NodeProps<Node<ServiceNodeData, 'service'>>) {
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const editingNodeId = useGraphStore((s) => s.editingNodeId)
  const startEditing = useGraphStore((s) => s.startEditing)
  const commitEditing = useGraphStore((s) => s.commitEditing)
  const updateNodeSize = useGraphStore((s) => s.updateNodeSize)
  const editDraft = useGraphStore((s) => s.editDraft)

  const nodeData = data ?? { label: 'service', flow: { nodes: [], edges: [] } }
  const isEditing = editingNodeId === id

  return (
    <div
      className={`service-node${isEditing ? ' service-node--editing' : ''}`}
      onDoubleClick={(e) => {
        if (isEditing) return
        e.stopPropagation()
        startEditing(activeLayer, id)
      }}
    >
      <NodeResizer
        minWidth={320}
        minHeight={200}
        color="#7a8bff"
        onResizeEnd={(_event, params) => updateNodeSize(activeLayer, id, params.width, params.height)}
      />
      <NodeSideHandles isConnectable={!isEditing} />
      {isEditing ? (
        <ServiceEditForm
          label={editDraft?.label ?? nodeData.label}
          onLabel={(label) => useGraphStore.getState().updateEditDraft({ label })}
          onSave={() => commitEditing(activeLayer)}
          onCancel={() => useGraphStore.getState().cancelEditing()}
        />
      ) : (
        <ServiceView id={id} data={nodeData} />
      )}
    </div>
  )
}

export default ServiceNode
