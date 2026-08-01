import { useGraphStore } from '../store'
import { MenuAction, MenuSeparator, MenuSubmenu } from './types'
import type { MenuContext, MenuItem } from './types'
import { makeLogicNode, makeNode } from '../nodeFactory'
import type { ClassNodeData, Layer, LogicKind, NestedFlow as NestedFlowGraph } from '../types'

export function buildPaneMenu(ctx: MenuContext): MenuItem[] {
  const store = useGraphStore.getState()
  const menu: MenuItem[] = [
    new MenuAction('Add rectangle', () => store.addNodeAt(ctx.layer, makeNode('rect', ctx.x, ctx.y)), '▭'),
    new MenuAction('Add circle', () => store.addNodeAt(ctx.layer, makeNode('circle', ctx.x, ctx.y)), '◯'),
    new MenuAction('Add table', () => store.addNodeAt(ctx.layer, makeNode('table', ctx.x, ctx.y)), '+'),
  ]
  if (ctx.layer !== 'db') {
    menu.push(new MenuAction('Add class', () => store.addNodeAt(ctx.layer, makeNode('class', ctx.x, ctx.y)), '❏'))
  }
  if (ctx.layer === 'backend') {
    menu.push(new MenuAction('Add service', () => store.addNodeAt(ctx.layer, makeNode('service', ctx.x, ctx.y)), '⊞'))
  }
  return [
    ...menu,
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
  const isClass = node?.type === 'class'
  const isService = node?.type === 'service'
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

  const items: MenuItem[] = [
    new MenuAction(
      isClass ? 'Edit class' : isService ? 'Edit service' : isShape ? 'Edit shape' : 'Edit table',
      () => store.startEditing(layer, nodeId),
      '✎',
    ),
  ]

  if (isClass) {
    const methods = ((node?.data as ClassNodeData | undefined)?.methods ?? []).filter(
      (m) => m.name,
    )
    const expandedId = store.expandedMethod[nodeId] ?? null
    items.push(
      new MenuSubmenu(
        'Expand method',
        methods.length > 0
          ? methods.map((m) =>
              new MenuAction(
                `${expandedId === m.id ? '▾' : '▸'} ${m.name}`,
                () => store.setExpandedMethod(nodeId, expandedId === m.id ? null : m.id),
              ),
            )
          : [new MenuAction('No methods', () => undefined)],
      ),
    )
  }

  if (isService) {
    items.push(
      new MenuAction(
        store.expanded[nodeId] ? 'Collapse service' : 'Expand service',
        () => store.toggleExpanded(nodeId),
      ),
    )
  }

  items.push(new MenuSubmenu('Wire from here', wireTargets, '∿'))
  items.push(new MenuSeparator())
  items.push(new MenuAction('Duplicate', () => store.duplicateNode(layer, nodeId), '⧉'))
  items.push(
    new MenuAction(
      'Delete',
      () => store.removeNodes(layer, [nodeId]),
      '🗑',
      true,
    ),
  )
  return items
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

/**
 * Context for menus that operate on a nested sub-flow graph. The graph is
 * passed along with the click position; menu actions must route mutations
 * through `onCommit` (which updates the owning node's data).
 */
export interface NestedFlowMenuContext {
  layer: Layer
  x: number
  y: number
  graph: NestedFlowGraph
  onCommit: (graph: NestedFlowGraph) => void
}

const LOGIC_KINDS: LogicKind[] = ['start', 'step', 'branch', 'call', 'end']

const LOGIC_ICON: Record<LogicKind, string> = {
  start: '▶',
  step: '·',
  branch: '◇',
  call: '⇢',
  end: '■',
}

const LOGIC_OFFSET: Record<LogicKind, number> = {
  start: -40,
  step: -20,
  branch: 0,
  call: 20,
  end: 40,
}

/** Pane menu inside a method sub-flow: insert logic nodes into the flow. */
export function buildMethodFlowPaneMenu(ctx: NestedFlowMenuContext): MenuItem[] {
  return LOGIC_KINDS.map(
    (kind) =>
      new MenuAction(
        `Add ${kind}`,
        () => {
          ctx.onCommit({
            ...ctx.graph,
            nodes: [...ctx.graph.nodes, makeLogicNode(kind, ctx.x, ctx.y + LOGIC_OFFSET[kind])],
          })
        },
        LOGIC_ICON[kind],
      ),
  )
}

/** Pane menu inside a service sub-flow: add a class node to the flow. */
export function buildServiceFlowPaneMenu(ctx: NestedFlowMenuContext): MenuItem[] {
  return [
    new MenuAction(
      'Add class',
      () => {
        ctx.onCommit({
          ...ctx.graph,
          nodes: [...ctx.graph.nodes, makeNode('class', ctx.x, ctx.y)],
        })
      },
      '❏',
    ),
  ]
}
