import type { Edge, Node } from '@xyflow/react'

export type Layer = 'backend' | 'db' | 'frontend'

export type NodeType = 'table' | 'shape' | 'preview'

export type ShapeKind = 'rect' | 'circle'

export interface Column {
  name: string
  type: string
  constraint: string
}

export interface TableNodeData {
  label: string
  columns: Column[]
  [key: string]: unknown
}

export interface ShapeNodeData {
  kind: ShapeKind
  label: string
  items: string[]
  [key: string]: unknown
}

export interface PreviewNodeData {
  kind: 'table' | ShapeKind
  [key: string]: unknown
}

export type GraphNodeData =
  | TableNodeData
  | ShapeNodeData
  | PreviewNodeData
  | Record<string, never>

export type AppNode = Node<GraphNodeData, NodeType>
export type AppEdge = Edge

export interface LayerGraph {
  nodes: AppNode[]
  edges: AppEdge[]
}

/** Snapshot of a node's editable fields, taken when editing starts (for cancel). */
export interface EditDraft {
  label: string
  columns: Column[]
  items: string[]
}

export type Severity = 'error' | 'warning' | 'info'

export interface Issue {
  node_id: string | null
  severity: Severity
  message: string
}

export interface ValidationReport {
  scope: string
  passed: boolean
  issues: Issue[]
}

export interface Task {
  id: string
  title: string
  description: string
  depends_on: string[]
  files: string[]
}

export interface TaskList {
  tasks: Task[]
  generated_at: string
}
