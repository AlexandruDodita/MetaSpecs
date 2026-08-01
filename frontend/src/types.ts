import type { Edge, Node } from '@xyflow/react'

export type Layer = 'backend' | 'db' | 'frontend'

export type NodeType = 'table' | 'shape' | 'class' | 'service' | 'preview'

export type ShapeKind = 'rect' | 'circle'

export type Visibility = 'public' | 'private' | 'protected'

export type LogicKind = 'step' | 'branch' | 'call'

export type EdgeKind = 'contains' | 'calls' | 'implements' | 'reads' | 'writes' | 'depends-on'

export const EDGE_KINDS: readonly EdgeKind[] = [
  'contains',
  'calls',
  'implements',
  'reads',
  'writes',
  'depends-on',
]

export interface Column {
  name: string
  type: string
  constraint: string
}

export interface TableNodeData {
  label: string
  columns: Column[]
  path?: string
  description?: string
  [key: string]: unknown
}

export interface ShapeNodeData {
  kind: ShapeKind
  label: string
  items: string[]
  path?: string
  description?: string
  [key: string]: unknown
}

export interface Field {
  name: string
  visibility: Visibility
  type: string
}

/** One row in a method's logic tree (start/end are implicit). */
export interface LogicStep {
  id: string
  kind: LogicKind
  label: string
}

export interface Method {
  id: string
  name: string
  visibility: Visibility
  returnType: string
  params: string
  steps: LogicStep[]
}

export interface ClassNodeData {
  label: string
  fields: Field[]
  methods: Method[]
  path?: string
  description?: string
  [key: string]: unknown
}

export interface ServiceNodeData {
  label: string
  path?: string
  description?: string
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
  | PreviewNodeData
  | Record<string, never>

export type AppNode = Node<GraphNodeData, NodeType>
export type AppEdge = Edge & { kind?: EdgeKind; protocol?: string }

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
  path: string
  description: string
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
  repo_path: string
}

export interface ImportStats {
  files_scanned: number
  files_skipped: number
  by_language: Record<string, number>
  by_layer: Record<string, number>
  node_count: number
  edge_count: number
  warnings: string[]
}

export interface ImportResult {
  project_id: string
  root: string
  path: string
  stats: ImportStats
  layers: Record<string, number>
}

export interface DirEntry {
  name: string
  path: string
  is_repo: boolean
}

export interface DirListing {
  path: string
  parent: string | null
  home: string
  entries: DirEntry[]
  truncated: boolean
}

export interface ProjectReports {
  scope: string
  validation: ValidationReport | null
  tasks: TaskList | null
}
