import { useMemo } from 'react'
import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { Node } from '@xyflow/react'
import type { AppNode, ClassNodeData, FileNodeData } from '../types'
import { useGraphStore, isExpanded, membershipNeighbours } from '../store'
import { TreeClassRow, TreeMethodRow } from './Tree'
import NodeSideHandles from './NodeSideHandles'
import { NodeMeta } from './NodeMeta'

/** Classes wired to the file (membership = `contains`/`depends-on` edges). */
function useMemberClasses(nodeId: string): AppNode[] {
  const layer = useGraphStore((s) => s.activeLayer)
  const nodes = useGraphStore((s) => s.graphs[layer].nodes)
  const edges = useGraphStore((s) => s.graphs[layer].edges)
  return useMemo(() => {
    const neighbours = new Set(membershipNeighbours(edges).get(nodeId) ?? [])
    return nodes.filter((n) => neighbours.has(n.id) && n.type === 'class')
  }, [nodes, edges, nodeId])
}

function FileEditForm({
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
      className="file-edit"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="file-edit__title">Edit file</div>
      <input
        className="file-edit__name"
        value={label}
        onChange={(e) => onLabel(e.target.value)}
        placeholder="file name"
        autoFocus
      />
      <NodeMeta block="file" path={path} description={description} onChange={onChange} />
      <div className="file-edit__actions">
        <button onClick={onSave}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function FileView({ id, data }: { id: string; data: FileNodeData }) {
  const expanded = useGraphStore((s) => isExpanded(s.expanded, id, 'file'))
  const toggleExpanded = useGraphStore((s) => s.toggleExpanded)
  const classes = useMemberClasses(id)

  const label = data.label ?? 'file'
  const path = data.path ?? ''
  const notes = data.notes ?? ''
  const methods = data.methods ?? []

  const toggle = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    toggleExpanded(id, 'file')
  }

  return (
    <>
      <div className="file-node__header" onClick={toggle} title={expanded ? 'Collapse file' : 'Expand file'}>
        <span className="file-node__name">{label}</span>
        <span className="file-node__badge">FILE</span>
        <span className="file-node__count">
          {classes.length} class{classes.length === 1 ? '' : 'es'}
          {methods.length > 0 ? ` · ${methods.length} func${methods.length === 1 ? '' : 's'}` : ''}
        </span>
        <button className="file-node__toggle" onClick={toggle}>
          {expanded ? '▾' : '▸'}
        </button>
      </div>
      {path && <div className="node-meta__path">{path}</div>}
      {notes && <div className="file-node__notes">{notes}</div>}
      {expanded ? (
        <div className="service-node__tree">
          {methods.length === 0 && classes.length === 0 && (
            <div className="service-node__empty">empty file — wire a class with the wire tool</div>
          )}
          {methods.map((m) => (
            <TreeMethodRow key={m.id} method={m} depth={0} />
          ))}
          {classes.map((member) => (
            <TreeClassRow key={member.id} node={member} depth={0} />
          ))}
        </div>
      ) : (
        <div className="service-node__members">
          {classes.length === 0 && (
            <div className="service-node__empty">no classes wired</div>
          )}
          {classes.map((member) => {
            const mdata = (member.data ?? {}) as Partial<ClassNodeData>
            const methods_ = mdata.methods ?? []
            return (
              <div key={member.id} className="service-node__member" onClick={(e) => e.stopPropagation()}>
                <span className="service-node__member-name">{mdata.label ?? 'class'}</span>
                <span className="service-node__member-meta">
                  {methods_.length} method{methods_.length === 1 ? '' : 's'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function FileNode({ id, data }: NodeProps<Node<FileNodeData, 'file'>>) {
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const editingNodeId = useGraphStore((s) => s.editingNodeId)
  const startEditing = useGraphStore((s) => s.startEditing)
  const commitEditing = useGraphStore((s) => s.commitEditing)
  const updateNodeSize = useGraphStore((s) => s.updateNodeSize)
  const editDraft = useGraphStore((s) => s.editDraft)

  const nodeData = data ?? { label: 'file', fields: [], methods: [] }
  const isEditing = editingNodeId === id

  return (
    <div
      className={`file-node${isEditing ? ' file-node--editing' : ''}`}
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
        <FileEditForm
          label={editDraft?.label ?? nodeData.label}
          path={editDraft?.path ?? ''}
          description={editDraft?.description ?? ''}
          onLabel={(label) => useGraphStore.getState().updateEditDraft({ label })}
          onChange={(patch) => useGraphStore.getState().updateEditDraft(patch)}
          onSave={() => commitEditing(activeLayer)}
          onCancel={() => useGraphStore.getState().cancelEditing()}
        />
      ) : (
        <FileView id={id} data={nodeData} />
      )}
    </div>
  )
}

export default FileNode
