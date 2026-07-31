import type { Layer, LayerGraph, TaskList, ValidationReport } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    throw new Error(`${path}: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export const loadGraph = (layer: Layer): Promise<LayerGraph> =>
  request<LayerGraph>(`/api/graph/${layer}`)

export const saveGraph = (layer: Layer, graph: LayerGraph): Promise<LayerGraph> =>
  request<LayerGraph>(`/api/graph/${layer}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(graph),
  })

export const runValidate = (scope: string): Promise<ValidationReport> =>
  request<ValidationReport>('/api/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  })

export const runCompile = (scope: string): Promise<TaskList> =>
  request<TaskList>('/api/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  })
