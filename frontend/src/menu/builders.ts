import { useGraphStore } from '../store'
import type { AppNode } from '../types'
import { MenuAction, MenuSeparator, MenuSubmenu } from './types'
import type { MenuContext, MenuItem } from './types'

function newNode(x: number, y: number): AppNode {
  return {
    id: `n-${Date.now()}`,
    type: 'table',
    position: { x, y },
    data: { label: 'table', columns: [{ name: 'id', type: 'uuid', constraint: 'PRIMARY KEY' }] },
  }
}

export function buildPaneMenu(ctx: MenuContext): MenuItem[] {
  const store = useGraphStore.getState()
  return [
    new MenuAction('Add table', () => store.addNodeAt(ctx.layer, newNode(ctx.x, ctx.y)), '+'),
    new MenuAction(
      'Wire tool',
      () => store.setTool('wire'),
      '∿',
    ),
    new MenuSeparator(),
    new MenuAction('Save layer', () => void store.persist(ctx.layer), '💾'),
    new MenuAction(
      'Clear graph',
      () => {
        if (window.confirm('Delete the entire graph on this layer?')) {
          store.clearLayer(ctx.layer)
        }
      },
      '🗑',
      true,
    ),
  ]
}

export function buildNodeMenu(ctx: MenuContext, nodeId: string): MenuItem[] {
  const store = useGraphStore.getState()
  const layer = ctx.layer
  const targets = store.graphs[layer].nodes.filter((n) => n.id !== nodeId)
  const nodeLabel = (id: string) =>
    store.graphs[layer].nodes.find((n) => n.id === id)?.data.label ?? id

  const wireTargets: MenuItem[] =
    targets.length > 0
      ? targets.map((t) =>
          new MenuAction(
            `→ ${nodeLabel(t.id)}`,
            () => store.connectNodes(layer, nodeId, t.id),
          ),
        )
      : [new MenuAction('No other tables', () => undefined)]

  return [
    new MenuAction('Edit table', () => store.startEditing(layer, nodeId), '✎'),
    new MenuSubmenu('Wire from here', wireTargets, '∿'),
    new MenuSeparator(),
    new MenuAction('Duplicate', () => store.duplicateNode(layer, nodeId), '⧉'),
    new MenuAction(
      'Delete table',
      () => store.removeNodes(layer, [nodeId]),
      '🗑',
      true,
    ),
  ]
}

export function buildEdgeMenu(ctx: MenuContext, edgeId: string): MenuItem[] {
  const store = useGraphStore.getState()
  return [
    new MenuAction('Delete connection', () => store.removeEdges(ctx.layer, [edgeId]), '🗑', true),
  ]
}
