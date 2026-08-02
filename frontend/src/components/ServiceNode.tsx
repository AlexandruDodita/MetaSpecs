import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { Node } from '@xyflow/react'
import type { AppNode, ClassNodeData, FileNodeData, ServiceNodeData } from '../types'
import { useGraphStore, isExpanded } from '../store'
import { TreeClassRow, TreeFileRow } from './Tree'
import NodeSideHandles from './NodeSideHandles'
import { NodeMeta } from './NodeMeta'

/** Files and classes wired to the service (membership = any edge in either direction). */
function useMembers(nodeId: string): { files: AppNode[]; classes: AppNode[] } {
  const layer = useGraphStore((s) => s.activeLayer)
  const nodes = useGraphStore((s) => s.graphs[layer].nodes)
  const edges = useGraphStore((s) => s.graphs[layer].edges)
  const members = edges
    .filter((e) => e.source === nodeId || e.target === nodeId)
    .map((e) => (e.source === nodeId ? e.target : e.source))
  const memberNodes = nodes.filter((n) => members.includes(n.id))
  return {
    files: memberNodes.filter((n) => n.type === 'file'),
    classes: memberNodes.filter((n) => n.type === 'class'),
  }
}

function ServiceEditForm({
  label,
  path,
  description,
  onLabel,
  onChange,
  onSave,
  onCancel,
}: {
  label: string
  path: string
  description: string
  onLabel: (label: string) => void
  onChange: (patch: { path?: string; description?: string }) => void
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
      <NodeMeta block="service" path={path} description={description} onChange={onChange} />
      <div className="service-edit__actions">
        <button onClick={onSave}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/** One line in the collapsed member list: a file or a class with its counts. */
function MemberRow({ node }: { node: AppNode }) {
  const isFile = node.type === 'file'
  const data = (node.data ?? {}) as Partial<ClassNodeData | FileNodeData>
  const methods = data.methods ?? []
  const label = data.label ?? (isFile ? 'file' : 'class')
  return (
    <div className="service-node__member" onClick={(e) => e.stopPropagation()}>
      <span className="service-node__member-name">{label}</span>
      <span className="service-node__member-meta">
        {isFile
          ? methods.length > 0
            ? `${methods.length} func${methods.length === 1 ? '' : 's'}`
            : 'file'
          : `${methods.length} method${methods.length === 1 ? '' : 's'}`}
      </span>
    </div>
  )
}

function ServiceView({ id, data }: { id: string; data: ServiceNodeData }) {
  const expanded = useGraphStore((s) => isExpanded(s.expanded, id, 'service'))
  const toggleExpanded = useGraphStore((s) => s.toggleExpanded)
  const { files, classes } = useMembers(id)

  const label = data.label ?? 'service'
  const path = data.path ?? ''
  const members = [...files, ...classes]

  const toggle = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    toggleExpanded(id, 'service')
  }

  return (
    <>
      <div className="service-node__header" onClick={toggle} title={expanded ? 'Collapse service' : 'Expand service'}>
        <span className="service-node__name">{label}</span>
        <span className="service-node__badge">SERVICE</span>
        <span className="service-node__count">
          {files.length} file{files.length === 1 ? '' : 's'}
          {classes.length > 0 ? ` · ${classes.length} class${classes.length === 1 ? '' : 'es'}` : ''}
        </span>
        <button className="service-node__toggle" onClick={toggle}>
          {expanded ? '▾' : '▸'}
        </button>
      </div>
      {path && <div className="node-meta__path">{path}</div>}
      {expanded ? (
        <div className="service-node__tree">
          {members.length === 0 && (
            <div className="service-node__empty">
              no files or classes wired — connect one with the wire tool
            </div>
          )}
          {files.map((member) => (
            <TreeFileRow key={member.id} node={member} depth={0} />
          ))}
          {classes.map((member) => (
            <TreeClassRow key={member.id} node={member} depth={0} />
          ))}
        </div>
      ) : (
        <div className="service-node__members">
          {members.length === 0 && (
            <div className="service-node__empty">no files or classes wired</div>
          )}
          {members.map((member) => (
            <MemberRow key={member.id} node={member} />
          ))}
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
          path={editDraft?.path ?? ''}
          description={editDraft?.description ?? ''}
          onLabel={(label) => useGraphStore.getState().updateEditDraft({ label })}
          onChange={(patch) => useGraphStore.getState().updateEditDraft(patch)}
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
