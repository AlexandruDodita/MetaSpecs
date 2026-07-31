import type { AppNode, ShapeKind, ShapeNodeData, TableNodeData } from './types'

export const DEFAULT_SIZE: Record<'table' | ShapeKind, { width: number; height: number }> = {
  table: { width: 260, height: 150 },
  rect: { width: 180, height: 110 },
  circle: { width: 120, height: 120 },
}

export function makeNodeId(): string {
  return `n-${Date.now()}`
}

export function makeTableData(label = 'table'): TableNodeData {
  return {
    label,
    columns: [{ name: 'id', type: 'uuid', constraint: 'PRIMARY KEY' }],
  }
}

export function makeShapeData(kind: ShapeKind, label = kind): ShapeNodeData {
  return { kind, label, items: [] }
}

export type PlaceableKind = 'table' | ShapeKind

/** Build a node placed at (x, y) with an explicit size. */
export function makeNode(
  kind: PlaceableKind,
  x: number,
  y: number,
  width?: number,
  height?: number,
): AppNode {
  const size = DEFAULT_SIZE[kind]
  return {
    id: makeNodeId(),
    type: kind === 'table' ? 'table' : 'shape',
    position: { x, y },
    style: { width: width ?? size.width, height: height ?? size.height },
    data: kind === 'table' ? makeTableData() : makeShapeData(kind),
  }
}
