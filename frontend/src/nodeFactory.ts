import type {
  AppNode,
  ClassNodeData,
  LogicKind,
  LogicNodeData,
  ServiceNodeData,
  ShapeKind,
  ShapeNodeData,
  TableNodeData,
} from './types'

export type PlaceableKind = 'table' | ShapeKind | 'class' | 'service'

export const DEFAULT_SIZE: Record<PlaceableKind, { width: number; height: number }> = {
  table: { width: 260, height: 150 },
  rect: { width: 180, height: 110 },
  circle: { width: 120, height: 120 },
  class: { width: 260, height: 180 },
  service: { width: 320, height: 240 },
}

export const MIN_SIZE: Record<PlaceableKind, { width: number; height: number }> = {
  table: { width: 260, height: 120 },
  rect: { width: 60, height: 60 },
  circle: { width: 60, height: 60 },
  class: { width: 260, height: 140 },
  service: { width: 320, height: 200 },
}

let seq = 0
export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`
}

export function makeNodeId(): string {
  return uid('n')
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

export function makeClassData(label = 'class'): ClassNodeData {
  return { label, fields: [], methods: [] }
}

export function makeServiceData(label = 'service'): ServiceNodeData {
  return { label, flow: { nodes: [], edges: [] } }
}

/** A logic node for nested method sub-flows (never lives in a top-level graph). */
export function makeLogicNode(kind: LogicKind, x: number, y: number): AppNode {
  const data: LogicNodeData = { kind, label: kind }
  return {
    id: makeNodeId(),
    type: 'logic',
    position: { x, y },
    style: { width: 120, height: 60 },
    data,
  }
}

/** Build a node placed at (x, y) with an explicit size. */
export function makeNode(
  kind: PlaceableKind,
  x: number,
  y: number,
  width?: number,
  height?: number,
): AppNode {
  const size = DEFAULT_SIZE[kind]
  const min = MIN_SIZE[kind]
  const w = Math.max(width ?? size.width, min.width)
  const h = Math.max(height ?? size.height, min.height)
  const type: AppNode['type'] =
    kind === 'table' || kind === 'class' || kind === 'service' ? kind : 'shape'
  const data =
    kind === 'table'
      ? makeTableData()
      : kind === 'class'
        ? makeClassData()
        : kind === 'service'
          ? makeServiceData()
          : makeShapeData(kind)
  return {
    id: makeNodeId(),
    type,
    position: { x, y },
    style: { width: w, height: h },
    data,
  }
}
