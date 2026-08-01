import { useCallback, useEffect, useState } from 'react'
import type { ImportResult, ProjectInfo } from '../types'
import { createProject, deleteProject, importRepo, listProjects } from '../api'
import { DirectoryPicker } from './DirectoryPicker'

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
  const [browsing, setBrowsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [imported, setImported] = useState<ProjectInfo | null>(null)

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

  const runImport = async (path: string) => {
    setImporting(true)
    setError(null)
    setResult(null)
    setImported(null)
    try {
      // A placeholder only: the import renames the project after the scanned
      // root, which is the first point anyone knows what the path resolves to.
      const segments = path.split('/').filter((s) => s && s !== '.' && s !== '..')
      const derived = segments.length > 0 ? segments[segments.length - 1] : 'Imported'
      const project = await createProject(derived)
      try {
        const res = await importRepo(project.id, path)
        setResult(res)
        setImported(project)
        await refresh()
      } catch (e) {
        try {
          await deleteProject(project.id)
        } catch {
          // failing cleanup must not mask the real import error
        }
        throw e
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
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
          <button type="submit" disabled={busy || importing}>
            {busy ? 'Creating…' : 'New project'}
          </button>
        </form>

        <div className="project-picker__import">
          <button
            type="button"
            onClick={() => { setError(null); setBrowsing(true) }}
            disabled={busy || importing}
          >
            {importing ? 'Scanning…' : 'Import codebase…'}
          </button>
        </div>
        <p className="project-picker__hint">
          Pick a folder on this machine and snapshot its services, classes and
          functions into a new project.
        </p>

        {error && <p className="error">{error}</p>}

        {result && imported && (
          <div className="project-picker__result">
            <button
              className="project-picker__dismiss"
              title="Dismiss"
              onClick={() => {
                setResult(null)
                setImported(null)
              }}
            >
              ×
            </button>
            <p className="project-picker__result-line">
              <strong>Imported {result.root}</strong> —{' '}
              <code>{result.path}</code>
            </p>
            {result.stats.node_count === 0 ? (
              <p className="project-picker__result-line">
                No source files recognised in that folder.
              </p>
            ) : (
              <p className="project-picker__result-line">
                {result.stats.files_scanned} files · {result.stats.node_count} nodes ·{' '}
                {result.stats.edge_count} edges
                {result.stats.files_skipped > 0
                  ? ` · ${result.stats.files_skipped} skipped`
                  : ''}
              </p>
            )}
            <p className="project-picker__result-line">
              {Object.entries(result.layers)
                .map(([layer, count]) => `${layer} ${count}`)
                .join(' · ')}
            </p>
            {Object.keys(result.stats.by_language).length > 0 && (
              <p className="project-picker__result-line">
                {Object.entries(result.stats.by_language)
                  .map(([lang, count]) => `${lang} ${count}`)
                  .join(' · ')}
              </p>
            )}
            {result.stats.warnings.length > 0 && (
              <ul className="project-picker__warnings">
                {result.stats.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            )}
            <button onClick={() => onOpen(imported)}>Open {result.root}</button>
          </div>
        )}

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
                    disabled={busy || importing}
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
                    disabled={busy || importing}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {browsing && (
          <DirectoryPicker
            onCancel={() => setBrowsing(false)}
            onChoose={(path) => { setBrowsing(false); void runImport(path) }}
          />
        )}
      </div>
    </div>
  )
}
