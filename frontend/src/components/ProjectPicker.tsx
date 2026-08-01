import { useCallback, useEffect, useState } from 'react'
import type { ProjectInfo } from '../types'
import { createProject, deleteProject, listProjects } from '../api'

interface ProjectPickerProps {
  onOpen: (project: ProjectInfo) => void
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ProjectPicker({ onOpen }: ProjectPickerProps) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setProjects(await listProjects())
  }, [])

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message))
  }, [refresh])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const project = await createProject(name.trim() || 'Untitled')
      onOpen(project)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const remove = async (project: ProjectInfo) => {
    if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) return
    setBusy(true)
    setError(null)
    try {
      await deleteProject(project.id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-picker">
      <div className="project-picker__inner">
        <h1>MetaSpecs</h1>
        <p className="project-picker__subtitle">Visual Spec Builder</p>

        <form
          className="project-picker__create"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <input
            className="project-picker__name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name…"
            autoFocus
          />
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'New project'}
          </button>
        </form>

        {error && <p className="error">{error}</p>}

        <div className="project-picker__list">
          {projects === null ? (
            <p className="project-picker__empty">Loading projects…</p>
          ) : projects.length === 0 ? (
            <p className="project-picker__empty">
              No projects yet — create one above.
            </p>
          ) : (
            <ul>
              {projects.map((project) => (
                <li key={project.id} className="project-picker__row">
                  <button
                    className="project-picker__open"
                    onClick={() => onOpen(project)}
                    disabled={busy}
                  >
                    <strong>{project.name}</strong>
                    <span className="project-picker__meta">
                      {project.node_count} nodes · updated{' '}
                      {formatDate(project.updated_at)}
                    </span>
                  </button>
                  <button
                    className="project-picker__delete"
                    title={`Delete "${project.name}"`}
                    onClick={() => void remove(project)}
                    disabled={busy}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
