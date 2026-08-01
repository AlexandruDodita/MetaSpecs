import type { Layer, LayerGraph, ProjectInfo, ProjectReports, TaskList, ValidationReport } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    throw new Error(`${path}: ${res.status} ${res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const listProjects = (): Promise<ProjectInfo[]> =>
  request<{ projects: ProjectInfo[] }>('/api/projects').then((r) => r.projects)

export const createProject = (name: string): Promise<ProjectInfo> =>
  request<ProjectInfo>('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })

export const getProject = (id: string): Promise<ProjectInfo> =>
  request<ProjectInfo>(`/api/projects/${id}`)

export const deleteProject = (id: string): Promise<void> =>
  request<void>(`/api/projects/${id}`, { method: 'DELETE' })

export const getProjectReports = (id: string): Promise<ProjectReports> =>
  request<ProjectReports>(`/api/projects/${id}/reports`)

export const loadGraph = (projectId: string, layer: Layer): Promise<LayerGraph> =>
  request<LayerGraph>(`/api/projects/${projectId}/graph/${layer}`)

export const saveGraph = (
  projectId: string,
  layer: Layer,
  graph: LayerGraph,
): Promise<LayerGraph> =>
  request<LayerGraph>(`/api/projects/${projectId}/graph/${layer}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(graph),
  })

export const runValidate = (projectId: string, scope: string): Promise<ValidationReport> =>
  request<ValidationReport>(`/api/projects/${projectId}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  })

export const runCompile = (projectId: string, scope: string): Promise<TaskList> =>
  request<TaskList>(`/api/projects/${projectId}/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  })
