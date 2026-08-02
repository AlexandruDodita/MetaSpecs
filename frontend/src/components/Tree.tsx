import { useState } from 'react'
import type { AppNode, ClassNodeData, FileNodeData, Method } from '../types'
import { useGraphStore } from '../store'
import { Highlighted, VisibilityBadge } from './Highlighted'

/** Classes wired to a node (membership = any edge in either direction). */
function useMemberClasses(nodeId: string): AppNode[] {
  const layer = useGraphStore((s) => s.activeLayer)
  const nodes = useGraphStore((s) => s.graphs[layer].nodes)
  const edges = useGraphStore((s) => s.graphs[layer].edges)
  const members = edges
    .filter((e) => e.source === nodeId || e.target === nodeId)
    .map((e) => (e.source === nodeId ? e.target : e.source))
  return nodes.filter((n) => members.includes(n.id) && n.type === 'class')
}

/** A docstring/JSDoc block inside a tree row. */
export function TreeNotes({ text, depth }: { text?: string; depth: number }) {
  if (!text) return null
  return (
    <div className="tree-notes" style={{ paddingLeft: 10 + depth * 16 }}>
      {text}
    </div>
  )
}

/** Method row inside a container tree: expands to notes, then steps. */
export function TreeMethodRow({ method, depth }: { method: Method; depth: number }) {
  const [open, setOpen] = useState(false)
  const steps = method.steps ?? []
  const notes = method.notes ?? ''
  const calls = method.calls ?? []
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
          {calls.length > 0 && (
            <div className="tree-calls" style={{ paddingLeft: 10 + (depth + 1) * 16 }}>
              <span className="tree-calls__glyph">⇢</span> {calls.join(', ')}
            </div>
          )}
          <TreeNotes text={notes} depth={depth + 1} />
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

/** Class row inside a container tree: expands to notes, then methods. */
export function TreeClassRow({ node, depth }: { node: AppNode; depth: number }) {
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
          <TreeNotes text={data.notes} depth={depth + 1} />
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

/** File row inside a service tree: notes, the file's own functions, then its classes. */
export function TreeFileRow({ node, depth }: { node: AppNode; depth: number }) {
  const [open, setOpen] = useState(false)
  const data = (node.data ?? {}) as Partial<FileNodeData>
  const methods = data.methods ?? []
  const classes = useMemberClasses(node.id)
  return (
    <div className="tree-branch">
      <div
        className="tree-row tree-row--file"
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        <span className="tree-row__chevron">{open ? '▾' : '▸'}</span>
        <span className="tree-row__name">{data.label ?? 'file'}</span>
        <span className="tree-row__badge">FILE</span>
        <span className="tree-row__count">
          {classes.length} class{classes.length === 1 ? '' : 'es'} · {methods.length} func{methods.length === 1 ? '' : 's'}
        </span>
      </div>
      {open && (
        <div className="tree-branch">
          <TreeNotes text={data.notes} depth={depth + 1} />
          {methods.map((m) => (
            <TreeMethodRow key={m.id} method={m} depth={depth + 1} />
          ))}
          {classes.map((c) => (
            <TreeClassRow key={c.id} node={c} depth={depth + 1} />
          ))}
          {methods.length === 0 && classes.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: 10 + (depth + 1) * 16 }}>empty file</div>
          )}
        </div>
      )}
    </div>
  )
}
