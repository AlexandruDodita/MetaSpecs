import { useEffect, useMemo } from 'react'
import { useGraphStore, useCanUndo, useCanRedo } from '../store'
import type { Tool } from '../store'
import type { Layer } from '../types'

interface ToolEntry {
  id: Tool
  icon: string
  label: string
  key: string
  /** Layers this tool is available on; omitted = all layers. */
  layers?: Layer[]
}

const TOOLS: ToolEntry[] = [
  { id: 'select', icon: '⯈', label: 'Select / move — Shift+drag to box-select', key: 'V' },
  { id: 'rect', icon: '▭', label: 'Draw rectangle (drag on canvas)', key: 'R' },
  { id: 'circle', icon: '◯', label: 'Draw circle (drag on canvas)', key: 'C' },
  { id: 'table', icon: '▦', label: 'Draw table (drag on canvas)', key: 'T' },
  { id: 'class', icon: '❏', label: 'Draw class (drag on canvas)', key: 'K', layers: ['backend', 'frontend'] },
  { id: 'service', icon: '⊞', label: 'Draw service (drag on canvas)', key: 'S', layers: ['backend'] },
  { id: 'file', icon: '❐', label: 'Draw file (drag on canvas)', key: 'F', layers: ['backend', 'frontend'] },
  { id: 'wire', icon: '∿', label: 'Wire tool (click source, then target)', key: 'W' },
]

export function Toolbar() {
  const tool = useGraphStore((s) => s.tool)
  const setTool = useGraphStore((s) => s.setTool)
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const selected = useGraphStore((s) => s.selectedNodeIds)
  const startEditing = useGraphStore((s) => s.startEditing)
  const duplicateNode = useGraphStore((s) => s.duplicateNode)
  const deleteSelection = useGraphStore((s) => s.deleteSelection)
  const clearLayer = useGraphStore((s) => s.clearLayer)
  const persist = useGraphStore((s) => s.persist)
  const dirty = useGraphStore((s) => s.dirty)
  const undo = useGraphStore((s) => s.undo)
  const redo = useGraphStore((s) => s.redo)

  const layer: Layer = activeLayer
  const hasSelection = selected.length > 0
  const canUndo = useCanUndo(layer)
  const canRedo = useCanRedo(layer)
  const visibleTools = useMemo(() => TOOLS.filter((t) => !t.layers || t.layers.includes(layer)), [layer])

  useEffect(() => {
    if (tool !== 'select' && !visibleTools.some((t) => t.id === tool)) setTool('select')
  }, [visibleTools, tool, setTool])

  return (
    <aside className="toolbar" aria-label="tools">
      {visibleTools.map((t) => (
        <button
          key={t.id}
          className={`toolbar__btn ${tool === t.id ? 'toolbar__btn--active' : ''}`}
          title={`${t.label} (${t.key})`}
          onClick={() => setTool(tool === t.id ? 'select' : t.id)}
        >
          <span className="toolbar__icon">{t.icon}</span>
          <span className="toolbar__key">{t.key}</span>
        </button>
      ))}

      <div className="toolbar__divider" />

      <button
        className="toolbar__btn"
        title="Edit selected node"
        disabled={!hasSelection}
        onClick={() => startEditing(layer, selected[0])}
      >
        <span className="toolbar__icon">✎</span>
      </button>
      <button
        className="toolbar__btn"
        title="Duplicate selected node"
        disabled={!hasSelection}
        onClick={() => selected.forEach((id) => duplicateNode(layer, id))}
      >
        <span className="toolbar__icon">⧉</span>
      </button>
      <button
        className="toolbar__btn toolbar__btn--danger"
        title="Delete selected nodes"
        disabled={!hasSelection}
        onClick={() => deleteSelection(layer)}
      >
        <span className="toolbar__icon">🗑</span>
      </button>

      <div className="toolbar__divider" />

      <button
        className="toolbar__btn"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={() => undo(layer)}
      >
        <span className="toolbar__icon">↶</span>
      </button>
      <button
        className="toolbar__btn"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={() => redo(layer)}
      >
        <span className="toolbar__icon">↷</span>
      </button>

      <div className="toolbar__divider" />

      <button
        className="toolbar__btn"
        title="Save layer to backend"
        onClick={() => void persist(layer)}
      >
        <span className="toolbar__icon">💾</span>
      </button>
      <button
        className="toolbar__btn toolbar__btn--danger"
        title="Clear this graph"
        onClick={() => {
          if (window.confirm('Delete the entire graph on this layer?')) {
            clearLayer(layer)
          }
        }}
      >
        <span className="toolbar__icon">✕</span>
      </button>

      {dirty[layer] && <span className="toolbar__dirty">●</span>}
    </aside>
  )
}
