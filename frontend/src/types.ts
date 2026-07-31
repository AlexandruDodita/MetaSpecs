import type { Edge, Node } from '@xyflow/react'

export type Layer = 'backend' | 'db' | 'frontend'

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

export type GraphNodeData = TableNodeData | Record<string, never>

export type AppNode = Node<GraphNodeData, 'table'>
export type AppEdge = Edge

export interface LayerGraph {
  nodes: AppNode[]
  edges: AppEdge[]
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
