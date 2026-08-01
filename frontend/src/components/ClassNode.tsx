import { useState } from 'react'
import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { Node } from '@xyflow/react'
import type { ClassNodeData, Field, Method, NestedFlow as NestedFlowGraph } from '../types'
import { useGraphStore } from '../store'
import { uid } from '../nodeFactory'
import { NestedFlow, useNestedFlowContext } from './NestedFlow'
import { Highlighted, VisibilityBadge } from './Highlighted'
import LogicNode from './LogicNode'
import { buildMethodFlowPaneMenu } from '../menu/builders'
import { MenuAction } from '../menu/types'
import NodeSideHandles from './NodeSideHandles'

const VISIBILITIES: readonly ['public', 'private', 'protected'] = [
  'public',
  'private',
  'protected',
]

const EMPTY_FLOW: NestedFlowGraph = { nodes: [], edges: [] }

function deepCopyFlow(flow: NestedFlowGraph): NestedFlowGraph {
  return {
    nodes: flow.nodes.map((n) => ({ ...n, data: { ...(n.data as object) } })),
    edges: flow.edges.map((e) => ({ ...e })),
  }
}

function deepCopyMethod(m: Method): Method {
  return { ...m, flow: deepCopyFlow(m.flow) }
}

export interface ClassEditState {
  label: string
  fields: Field[]
  methods: Method[]
}

function ClassEditForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: ClassEditState
  onChange: (patch: Partial<ClassEditState>) => void
  onSave: () => void
  onCancel: () => void
}) {
  const setField = (index: number, field: 'name' | 'visibility' | 'type', value: string) => {
    onChange({
      fields: draft.fields.map((f, i) => (i === index ? { ...f, [field]: value } : f)),
    })
  }

  const setMethod = (
    index: number,
    field: 'name' | 'visibility' | 'params' | 'returnType',
    value: string,
  ) => {
    onChange({
      methods: draft.methods.map((m, i) => (i === index ? { ...m, [field]: value } : m)),
    })
  }

  const addField = () =>
    onChange({ fields: [...draft.fields, { name: '', visibility: 'private', type: '' }] })

  const addMethod = () =>
    onChange({
      methods: [
        ...draft.methods,
        {
          id: uid('m'),
          name: '',
          visibility: 'private',
          returnType: '',
          params: '',
          flow: EMPTY_FLOW,
        },
      ],
    })

  const removeMethod = (index: number) =>
    onChange({ methods: draft.methods.filter((_, i) => i !== index) })

  return (
    <div
      className="class-edit"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="class-edit__title">Edit class</div>
      <input
        className="class-edit__name"
        value={draft.label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="class name"
        autoFocus
      />
      <div className="class-edit__section">fields</div>
      {draft.fields.map((f, i) => (
        <div key={i} className="class-edit__row class-edit__row--field">
          <select
            className="class-edit__select"
            value={f.visibility}
            onChange={(e) => setField(i, 'visibility', e.target.value)}
          >
            {VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <input
            className="class-edit__input"
            value={f.name}
            onChange={(e) => setField(i, 'name', e.target.value)}
            placeholder="name"
          />
          <input
            className="class-edit__input"
            value={f.type}
            onChange={(e) => setField(i, 'type', e.target.value)}
            placeholder="type"
          />
        </div>
      ))}
      <button className="class-edit__add" onClick={addField}>
        + field
      </button>
      <div className="class-edit__section">methods</div>
      {draft.methods.map((m, i) => (
        <div key={m.id} className="class-edit__row class-edit__row--method">
          <select
            className="class-edit__select"
            value={m.visibility}
            onChange={(e) => setMethod(i, 'visibility', e.target.value)}
          >
            {VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <input
            className="class-edit__input"
            value={m.name}
            onChange={(e) => setMethod(i, 'name', e.target.value)}
            placeholder="name"
          />
          <input
            className="class-edit__input"
            value={m.params}
            onChange={(e) => setMethod(i, 'params', e.target.value)}
            placeholder="params (id: uuid, limit: number)"
          />
          <input
            className="class-edit__input"
            value={m.returnType}
            onChange={(e) => setMethod(i, 'returnType', e.target.value)}
            placeholder="return"
          />
          <button className="class-edit__del" onClick={() => removeMethod(i)}>
            ×
          </button>
        </div>
      ))}
      <button className="class-edit__add" onClick={addMethod}>
        + method
      </button>
      <div className="class-edit__actions">
        <button onClick={onSave}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function ClassView({ data, id }: { data: ClassNodeData; id: string }) {
  const expandedMethod = useGraphStore((s) => s.expandedMethod)
  const setExpandedMethod = useGraphStore((s) => s.setExpandedMethod)
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const saveMethodFlow = useGraphStore((s) => s.saveMethodFlow)
  const nested = useNestedFlowContext()

  const label = data.label ?? 'class'
  const fields = data.fields ?? []
  const methods = data.methods ?? []

  const handleMethodFlowChange = (methodId: string, graph: NestedFlowGraph) => {
    const nextMethods = methods.map((m) =>
      m.id === methodId ? { ...m, flow: deepCopyFlow(graph) } : m,
    )
    if (nested) {
      nested.updateNodeData(id, { methods: nextMethods })
    } else {
      saveMethodFlow(activeLayer, id, methodId, graph)
    }
  }

  return (
    <>
      <div className="class-node__header">
        <span className="class-node__name">{label}</span>
        <span className="class-node__badge">CLASS</span>
      </div>
      <div className="class-node__body">
        <div className="class-node__section">
          <div className="class-node__section-title">FIELDS</div>
          {fields.length === 0 && <div className="class-node__empty">no fields</div>}
          {fields.map((f, i) => (
            <div key={i} className="field-row">
              <VisibilityBadge visibility={f.visibility} />
              <span className="field-row__name">{f.name || '(unnamed)'}</span>
              <span className="field-row__type">{f.type || '—'}</span>
            </div>
          ))}
        </div>
        <div className="class-node__section">
          <div className="class-node__section-title">METHODS</div>
          {methods.length === 0 && <div className="class-node__empty">no methods</div>}
          {methods.map((m) => {
            const isExpanded = expandedMethod[id] === m.id
            const flow = m.flow ?? EMPTY_FLOW
            return (
              <div key={m.id} className="method-row__wrap">
                <div
                  className={`method-row${isExpanded ? ' method-row--expanded' : ''}`}
                  onClick={() => setExpandedMethod(id, isExpanded ? null : m.id)}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <VisibilityBadge visibility={m.visibility} />
                  <Highlighted
                    text={`${m.name}(${m.params}): ${m.returnType}`}
                    className="method-row__sig"
                  />
                  <span className="method-row__chevron">{isExpanded ? '▾' : '▸'}</span>
                </div>
                {isExpanded && (
                  <div className="method-row__flow">
                    <NestedFlow
                      nodes={flow.nodes}
                      edges={flow.edges}
                      nodeTypes={{ logic: LogicNode }}
                      className="subflow subflow--method"
                      onChange={(g) => handleMethodFlowChange(m.id, g)}
                      onPaneContextMenu={(position, graph) =>
                        buildMethodFlowPaneMenu({
                          layer: activeLayer,
                          x: position.x,
                          y: position.y,
                          graph,
                          onCommit: (g) => handleMethodFlowChange(m.id, g),
                        })
                      }
                      onNodeContextMenu={(node, graph) => {
                        const keep = graph.nodes.filter((n) => n.id !== node.id)
                        const edges = graph.edges.filter(
                          (e) => e.source !== node.id && e.target !== node.id,
                        )
                        return [
                          new MenuAction(
                            'Delete',
                            () => handleMethodFlowChange(m.id, { nodes: keep, edges }),
                            '🗑',
                            true,
                          ),
                        ]
                      }}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

function ClassNode({ id, data }: NodeProps<Node<ClassNodeData, 'class'>>) {
  const nested = useNestedFlowContext()
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const editingNodeId = useGraphStore((s) => s.editingNodeId)
  const startEditing = useGraphStore((s) => s.startEditing)
  const commitEditing = useGraphStore((s) => s.commitEditing)
  const updateNodeSize = useGraphStore((s) => s.updateNodeSize)
  const editDraft = useGraphStore((s) => s.editDraft)

  const [localDraft, setLocalDraft] = useState<ClassEditState | null>(null)

  const nodeData = data ?? { label: 'class', fields: [], methods: [] }
  const isEditing = nested ? localDraft !== null : editingNodeId === id

  const openEdit = () => {
    if (nested) {
      setLocalDraft({
        label: nodeData.label,
        fields: nodeData.fields.map((f) => ({ ...f })),
        methods: nodeData.methods.map(deepCopyMethod),
      })
    } else {
      startEditing(activeLayer, id)
    }
  }

  const saveEdit = () => {
    if (nested) {
      if (localDraft) {
        nested.updateNodeData(id, {
          label: localDraft.label,
          fields: localDraft.fields,
          methods: localDraft.methods,
        })
      }
      setLocalDraft(null)
    } else {
      commitEditing(activeLayer)
    }
  }

  const cancelEdit = () => {
    if (nested) {
      setLocalDraft(null)
    } else {
      useGraphStore.getState().cancelEditing()
    }
  }

  const draft: ClassEditState = nested
    ? localDraft ?? {
        label: nodeData.label,
        fields: nodeData.fields,
        methods: nodeData.methods,
      }
    : {
        label: editDraft?.label ?? nodeData.label,
        fields: editDraft?.fields ?? nodeData.fields,
        methods: editDraft?.methods ?? nodeData.methods,
      }

  return (
    <div
      className={`class-node${isEditing ? ' class-node--editing' : ''}`}
      onDoubleClick={(e) => {
        if (isEditing) return
        e.stopPropagation()
        openEdit()
      }}
    >
      <NodeResizer
        minWidth={260}
        minHeight={140}
        color="#7a8bff"
        onResizeEnd={
          nested
            ? undefined
            : (_event, params) =>
                updateNodeSize(activeLayer, id, params.width, params.height)
        }
      />
      <NodeSideHandles isConnectable={!isEditing} />
      {isEditing ? (
        <ClassEditForm
          draft={draft}
          onChange={(patch) => {
            if (nested) {
              setLocalDraft((prev) => (prev ? { ...prev, ...patch } : prev))
            } else {
              useGraphStore.getState().updateEditDraft(patch)
            }
          }}
          onSave={saveEdit}
          onCancel={cancelEdit}
        />
      ) : (
        <ClassView data={nodeData} id={id} />
      )}
    </div>
  )
}

export default ClassNode
