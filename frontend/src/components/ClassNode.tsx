import { useState } from 'react'
import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { Node } from '@xyflow/react'
import type { ClassNodeData, Field, LogicKind, LogicStep, Method } from '../types'
import { useGraphStore } from '../store'
import { makeLogicStep, uid } from '../nodeFactory'
import { Highlighted, VisibilityBadge } from './Highlighted'
import NodeSideHandles from './NodeSideHandles'

const VISIBILITIES: readonly ['public', 'private', 'protected'] = [
  'public',
  'private',
  'protected',
]

const LOGIC_KINDS: readonly LogicKind[] = ['step', 'branch', 'call']

const LOGIC_BADGE: Record<LogicKind, string> = { step: '•', branch: '◇', call: '⇢' }

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
          steps: [],
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

function StepRow({
  step,
  editing,
  onStartEdit,
  onCommitLabel,
  onSetKind,
  onMove,
  onDelete,
}: {
  step: LogicStep
  editing: boolean
  onStartEdit: () => void
  onCommitLabel: (label: string) => void
  onSetKind: (kind: LogicKind) => void
  onMove: (dir: -1 | 1) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState(step.label)

  return (
    <div className="step-row" onClick={(e) => e.stopPropagation()}>
      {editing ? (
        <input
          className="step-row__edit"
          value={draft}
          autoFocus
          placeholder="what happens here?"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommitLabel(draft)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              onCommitLabel(draft)
            } else if (e.key === 'Escape') {
              setDraft(step.label)
              onCommitLabel(step.label)
            }
          }}
        />
      ) : (
        <span
          className="step-row__label"
          onDoubleClick={(e) => {
            e.stopPropagation()
            onStartEdit()
          }}
        >
          <Highlighted text={step.label || '(empty step)'} />
        </span>
      )}
      <select
        className="step-row__kind"
        value={step.kind}
        title="step kind"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onSetKind(e.target.value as LogicKind)}
      >
        {LOGIC_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <span className="step-row__badge" title={step.kind}>
        {LOGIC_BADGE[step.kind]}
      </span>
      <span className="step-row__ops">
        <button className="step-row__op" title="move up" onClick={() => onMove(-1)}>
          ↑
        </button>
        <button className="step-row__op" title="move down" onClick={() => onMove(1)}>
          ↓
        </button>
        <button className="step-row__op step-row__op--del" title="delete step" onClick={onDelete}>
          ×
        </button>
      </span>
    </div>
  )
}

function MethodSteps({ id, method }: { id: string; method: Method }) {
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const updateMethodSteps = useGraphStore((s) => s.updateMethodSteps)
  const [editingId, setEditingId] = useState<string | null>(null)

  const steps = method.steps ?? []

  const commit = (next: LogicStep[]) => updateMethodSteps(activeLayer, id, method.id, next)

  const addStep = () => {
    const step = makeLogicStep('step')
    commit([...steps, step])
    setEditingId(step.id)
  }

  const setLabel = (stepId: string, label: string) => {
    commit(steps.map((s) => (s.id === stepId ? { ...s, label } : s)))
    setEditingId(null)
  }

  const setKind = (stepId: string, kind: LogicKind) => {
    commit(steps.map((s) => (s.id === stepId ? { ...s, kind } : s)))
  }

  const move = (index: number, dir: -1 | 1) => {
    const next = [...steps]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    commit(next)
  }

  const remove = (index: number) => {
    commit(steps.filter((_, i) => i !== index))
    setEditingId(null)
  }

  return (
    <div className="method-steps">
      {steps.length === 0 && <div className="method-steps__empty">no steps yet</div>}
      {steps.map((step, i) => (
        <StepRow
          key={step.id}
          step={step}
          editing={editingId === step.id}
          onStartEdit={() => setEditingId(step.id)}
          onCommitLabel={(label) => setLabel(step.id, label)}
          onSetKind={(kind) => setKind(step.id, kind)}
          onMove={(dir) => move(i, dir)}
          onDelete={() => remove(i)}
        />
      ))}
      <button className="method-steps__add" onClick={addStep}>
        + step
      </button>
    </div>
  )
}

function ClassView({ data, id }: { data: ClassNodeData; id: string }) {
  const expandedMethod = useGraphStore((s) => s.expandedMethod)
  const setExpandedMethod = useGraphStore((s) => s.setExpandedMethod)
  const classExpanded = useGraphStore((s) => s.expanded[id]) !== false
  const toggleExpanded = useGraphStore((s) => s.toggleExpanded)

  const label = data.label ?? 'class'
  const fields = data.fields ?? []
  const methods = data.methods ?? []

  return (
    <>
      <div className="class-node__header">
        <span className="class-node__name">{label}</span>
        <span className="class-node__badge">CLASS</span>
        <button
          className="class-node__toggle"
          title={classExpanded ? 'Collapse class (hide methods)' : 'Expand class'}
          onClick={(e) => {
            e.stopPropagation()
            toggleExpanded(id)
          }}
        >
          {classExpanded ? '▾' : '▸'}
        </button>
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
        {classExpanded && (
          <div className="class-node__section">
            <div className="class-node__section-title">METHODS</div>
            {methods.length === 0 && <div className="class-node__empty">no methods</div>}
            {methods.map((m) => {
              const isExpanded = expandedMethod[id] === m.id
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
                  {isExpanded && <MethodSteps id={id} method={m} />}
                </div>
              )
            })}
          </div>
        )}
        {!classExpanded && methods.length > 0 && (
          <div className="class-node__hidden">methods hidden — expand class</div>
        )}
      </div>
    </>
  )
}

function ClassNode({ id, data }: NodeProps<Node<ClassNodeData, 'class'>>) {
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const editingNodeId = useGraphStore((s) => s.editingNodeId)
  const startEditing = useGraphStore((s) => s.startEditing)
  const commitEditing = useGraphStore((s) => s.commitEditing)
  const updateNodeSize = useGraphStore((s) => s.updateNodeSize)
  const editDraft = useGraphStore((s) => s.editDraft)

  const nodeData = data ?? { label: 'class', fields: [], methods: [] }
  const isEditing = editingNodeId === id

  const draft: ClassEditState = {
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
        startEditing(activeLayer, id)
      }}
    >
      <NodeResizer
        minWidth={260}
        minHeight={140}
        color="#7a8bff"
        onResizeEnd={(_event, params) => updateNodeSize(activeLayer, id, params.width, params.height)}
      />
      <NodeSideHandles isConnectable={!isEditing} />
      {isEditing ? (
        <ClassEditForm
          draft={draft}
          onChange={(patch) => useGraphStore.getState().updateEditDraft(patch)}
          onSave={() => commitEditing(activeLayer)}
          onCancel={() => useGraphStore.getState().cancelEditing()}
        />
      ) : (
        <ClassView data={nodeData} id={id} />
      )}
    </div>
  )
}

export default ClassNode
