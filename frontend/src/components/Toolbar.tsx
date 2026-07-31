import { useGraphStore } from '../store'
import type { Tool } from '../store'
import type { Layer } from '../types'

const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: 'select', icon: '⯈', label: 'Select / move', key: 'V' },
  { id: 'rect', icon: '▭', label: 'Draw rectangle (drag on canvas)', key: 'R' },
  { id: 'circle', icon: '◯', label: 'Draw circle (drag on canvas)', key: 'C' },
  { id: 'table', icon: '▦', label: 'Draw table (drag on canvas)', key: 'T' },
  { id: 'wire', icon: '∿', label: 'Wire tool (click source, then target)', key: 'W' },
]

export function Toolbar() {
  const tool = useGraphStore((s) => s.tool)
  const setTool = useGraphStore((s) => s.setTool)
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const selected = useGraphStore((s) => s.selectedNodeIds)
  const startEditing = useGraphStore((s) => s.startEditing)
  const duplicateNode = useGraphStore((s) => s.duplicateNode)
  const removeNodes = useGraphStore((s) => s.removeNodes)
  const clearLayer = useGraphStore((s) => s.clearLayer)
  const persist = useGraphStore((s) => s.persist)
  const dirty = useGraphStore((s) => s.dirty)

  const layer: Layer = activeLayer
  const hasSelection = selected.length > 0

  return (
    <aside className="toolbar" aria-label="tools">
      {TOOLS.map((t) => (
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
        onClick={() => removeNodes(layer, selected)}
      >
        <span className="toolbar__icon">🗑</span>
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
