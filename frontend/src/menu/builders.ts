import { useGraphStore } from '../store'
import { MenuAction, MenuSeparator, MenuSubmenu } from './types'
import type { MenuContext, MenuItem } from './types'
import { makeNode } from '../nodeFactory'

export function buildPaneMenu(ctx: MenuContext): MenuItem[] {
  const store = useGraphStore.getState()
  return [
    new MenuAction('Add rectangle', () => store.addNodeAt(ctx.layer, makeNode('rect', ctx.x, ctx.y)), '▭'),
    new MenuAction('Add circle', () => store.addNodeAt(ctx.layer, makeNode('circle', ctx.x, ctx.y)), '◯'),
    new MenuAction('Add table', () => store.addNodeAt(ctx.layer, makeNode('table', ctx.x, ctx.y)), '+'),
    new MenuSeparator(),
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
  const node = store.graphs[layer].nodes.find((n) => n.id === nodeId)
  const isShape = node?.type === 'shape'
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
      : [new MenuAction('No other nodes', () => undefined)]

  return [
    new MenuAction(
      isShape ? 'Edit shape' : 'Edit table',
      () => store.startEditing(layer, nodeId),
      '✎',
    ),
    new MenuSubmenu('Wire from here', wireTargets, '∿'),
    new MenuSeparator(),
    new MenuAction('Duplicate', () => store.duplicateNode(layer, nodeId), '⧉'),
    new MenuAction(
      'Delete',
      () => store.removeNodes(layer, [nodeId]),
      '🗑',
      true,
    ),
  ]
}

export function buildEdgeMenu(ctx: MenuContext, edgeId: string): MenuItem[] {
  const store = useGraphStore.getState()
  const layer = ctx.layer
  const edge = store.graphs[layer].edges.find((e) => e.id === edgeId)
  return [
    new MenuAction(
      'Label edge…',
      () => {
        const label = window.prompt('Edge label', edge?.label ? String(edge.label) : '')
        if (label !== null) {
          store.updateEdgeLabel(layer, edgeId, label)
        }
      },
      '🏷',
    ),
    new MenuAction('Delete connection', () => store.removeEdges(ctx.layer, [edgeId]), '🗑', true),
  ]
}
