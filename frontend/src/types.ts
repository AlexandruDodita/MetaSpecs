import type { Edge, Node } from '@xyflow/react'

export type Layer = 'backend' | 'db' | 'frontend'

export type NodeType = 'table' | 'shape' | 'class' | 'service' | 'logic' | 'preview'

export type ShapeKind = 'rect' | 'circle'

export type Visibility = 'public' | 'private' | 'protected'

export type LogicKind = 'start' | 'end' | 'step' | 'branch' | 'call'

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

export interface Field {
  name: string
  visibility: Visibility
  type: string
}

export interface NestedFlow {
  nodes: AppNode[]
  edges: AppEdge[]
}

export interface Method {
  id: string
  name: string
  visibility: Visibility
  returnType: string
  params: string
  flow: NestedFlow
}

export interface ClassNodeData {
  label: string
  fields: Field[]
  methods: Method[]
  [key: string]: unknown
}

export interface ServiceNodeData {
  label: string
  flow: NestedFlow
  [key: string]: unknown
}

export interface LogicNodeData {
  kind: LogicKind
  label: string
  [key: string]: unknown
}

export interface PreviewNodeData {
  kind: 'table' | ShapeKind | 'class' | 'service'
  [key: string]: unknown
}

export type GraphNodeData =
  | TableNodeData
  | ShapeNodeData
  | ClassNodeData
  | ServiceNodeData
  | LogicNodeData
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
  fields: Field[]
  methods: Method[]
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

export interface ProjectInfo {
  id: string
  name: string
  created_at: string
  updated_at: string
  node_count: number
}

export interface ProjectReports {
  scope: string
  validation: ValidationReport | null
  tasks: TaskList | null
}
