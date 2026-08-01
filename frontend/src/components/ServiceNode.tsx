import { useState } from 'react'
import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { Node } from '@xyflow/react'
import type { AppNode, ClassNodeData, Method, ServiceNodeData } from '../types'
import { useGraphStore } from '../store'
import { Highlighted, VisibilityBadge } from './Highlighted'
import NodeSideHandles from './NodeSideHandles'

/** Classes wired to the service (membership = any edge in either direction). */
function useMemberClasses(nodeId: string): AppNode[] {
  const layer = useGraphStore((s) => s.activeLayer)
  const nodes = useGraphStore((s) => s.graphs[layer].nodes)
  const edges = useGraphStore((s) => s.graphs[layer].edges)
  const members = edges
    .filter((e) => e.source === nodeId || e.target === nodeId)
    .map((e) => (e.source === nodeId ? e.target : e.source))
  return nodes.filter((n) => members.includes(n.id) && n.type === 'class')
}

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

/** Method row inside the service tree. */
function TreeMethodRow({ method, depth }: { method: Method; depth: number }) {
  const [open, setOpen] = useState(false)
  const steps = method.steps ?? []
  return (
    <div className="tree-branch">
      <div
        className="tree-row tree-row--method"
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        <span className="tree-row__chevron">{open ? '▾' : '▸'}</span>
        <VisibilityBadge visibility={method.visibility} />
        <Highlighted
          text={`${method.name}(${method.params}): ${method.returnType}`}
          className="tree-row__sig"
        />
        <span className="tree-row__count">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
      </div>
      {open && (
        <div className="tree-branch">
          {steps.length === 0 && <div className="tree-empty" style={{ paddingLeft: 10 + (depth + 1) * 16 }}>no steps</div>}
          {steps.map((s) => (
            <div key={s.id} className="tree-row tree-row--step" style={{ paddingLeft: 10 + (depth + 1) * 16 }}>
              <span className="tree-row__kind" title={s.kind}>•</span>
              <Highlighted text={s.label || '(empty step)'} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Class row inside the service tree. */
function TreeClassRow({ node, depth }: { node: AppNode; depth: number }) {
  const [open, setOpen] = useState(false)
  const data = (node.data ?? {}) as Partial<ClassNodeData>
  const methods = data.methods ?? []
  return (
    <div className="tree-branch">
      <div
        className="tree-row tree-row--class"
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        <span className="tree-row__chevron">{open ? '▾' : '▸'}</span>
        <span className="tree-row__name">{data.label ?? 'class'}</span>
        <span className="tree-row__badge">CLASS</span>
        <span className="tree-row__count">
          {methods.length} method{methods.length === 1 ? '' : 's'}
        </span>
      </div>
      {open && (
        <div className="tree-branch">
          {methods.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: 10 + (depth + 1) * 16 }}>no methods</div>
          )}
          {methods.map((m) => (
            <TreeMethodRow key={m.id} method={m} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function ServiceView({ id, data }: { id: string; data: ServiceNodeData }) {
  const expanded = useGraphStore((s) => s.expanded[id])
  const toggleExpanded = useGraphStore((s) => s.toggleExpanded)
  const members = useMemberClasses(id)

  const label = data.label ?? 'service'

  const toggle = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    toggleExpanded(id)
  }

  return (
    <>
      <div className="service-node__header" onClick={toggle} title={expanded ? 'Collapse service' : 'Expand service'}>
        <span className="service-node__name">{label}</span>
        <span className="service-node__badge">SERVICE</span>
        <span className="service-node__count">
          {members.length} class{members.length === 1 ? '' : 'es'}
        </span>
        <button className="service-node__toggle" onClick={toggle}>
          {expanded ? '▾' : '▸'}
        </button>
      </div>
      {expanded ? (
        <div className="service-node__tree">
          {members.length === 0 && (
            <div className="service-node__empty">
              no classes wired — connect a class with the wire tool
            </div>
          )}
          {members.map((member) => (
            <TreeClassRow key={member.id} node={member} depth={0} />
          ))}
        </div>
      ) : (
        <div className="service-node__members">
          {members.length === 0 && (
            <div className="service-node__empty">no classes wired</div>
          )}
          {members.map((member) => {
            const mdata = (member.data ?? {}) as Partial<ClassNodeData>
            const methods = mdata.methods ?? []
            return (
              <div key={member.id} className="service-node__member" onClick={(e) => e.stopPropagation()}>
                <span className="service-node__member-name">{mdata.label ?? 'class'}</span>
                <span className="service-node__member-meta">
                  {methods.length} method{methods.length === 1 ? '' : 's'}
                </span>
              </div>
            )
          })}
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

  const nodeData = data ?? { label: 'service' }
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
