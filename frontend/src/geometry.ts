import { DEFAULT_SIZE, type PlaceableKind } from './nodeFactory'
import type { AppNode, ShapeKind } from './types'

export type Side = 'top' | 'right' | 'bottom' | 'left'

export function nodeSizeOf(node: AppNode): { width: number; height: number } {
  const kind: PlaceableKind =
    node.type === 'table' ? 'table' : ((node.data as { kind?: ShapeKind }).kind ?? 'rect')
  const fallback = DEFAULT_SIZE[kind]
  return {
    width: node.width ?? (node.style?.width as number | undefined) ?? fallback.width,
    height: node.height ?? (node.style?.height as number | undefined) ?? fallback.height,
  }
}

/** A node or a bare rect (e.g. a cursor position rendered as a zero-size rect). */
export interface SizedRect {
  position: { x: number; y: number }
  width: number
  height: number
}

type RectLike = AppNode | SizedRect

function rectOf(node: RectLike): { x: number; y: number; width: number; height: number } {
  if ('data' in node) {
    const { width, height } = nodeSizeOf(node)
    return { x: node.position.x, y: node.position.y, width, height }
  }
  return { x: node.position.x, y: node.position.y, width: node.width, height: node.height }
}

const SIDE_MIDPOINT: Record<
  Side,
  (r: { x: number; y: number; width: number; height: number }) => { x: number; y: number }
> = {
  top: (r) => ({ x: r.x + r.width / 2, y: r.y }),
  right: (r) => ({ x: r.x + r.width, y: r.y + r.height / 2 }),
  bottom: (r) => ({ x: r.x + r.width / 2, y: r.y + r.height }),
  left: (r) => ({ x: r.x, y: r.y + r.height / 2 }),
}

export function sideAnchor(node: AppNode, side: Side): { x: number; y: number } {
  return SIDE_MIDPOINT[side](rectOf(node))
}

export function closestSides(
  a: AppNode | SizedRect,
  b: AppNode | SizedRect,
): { sourceSide: Side; targetSide: Side } {
  const ra = rectOf(a)
  const rb = rectOf(b)
  let best: { sourceSide: Side; targetSide: Side } = { sourceSide: 'top', targetSide: 'top' }
  let bestDist = Infinity
  for (const sourceSide of Object.keys(SIDE_MIDPOINT) as Side[]) {
    const pa = SIDE_MIDPOINT[sourceSide](ra)
    for (const targetSide of Object.keys(SIDE_MIDPOINT) as Side[]) {
      const pb = SIDE_MIDPOINT[targetSide](rb)
      const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y)
      if (dist < bestDist) {
        bestDist = dist
        best = { sourceSide, targetSide }
      }
    }
  }
  return best
}

/** A pointer as a zero-size rect, so it can reuse the closest-sides code path. */
export function pointNode(p: { x: number; y: number }): SizedRect {
  return { position: { x: p.x, y: p.y }, width: 0, height: 0 }
}
