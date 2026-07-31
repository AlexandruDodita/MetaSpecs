import { useEffect, useState } from 'react'
import type { Layer, TaskList, ValidationReport } from './types'
import { useGraphStore } from './store'
import { GraphCanvas } from './components/GraphCanvas'
import { runCompile, runValidate } from './api'

const LAYERS: { key: Layer; label: string }[] = [
  { key: 'backend', label: 'Backend' },
  { key: 'db', label: 'Database' },
  { key: 'frontend', label: 'Frontend' },
]

const SEVERITY_LABEL: Record<string, string> = {
  error: '!',
  warning: '▲',
  info: 'i',
}

function App() {
  const activeLayer = useGraphStore((s) => s.activeLayer)
  const setActiveLayer = useGraphStore((s) => s.setActiveLayer)
  const addNode = useGraphStore((s) => s.addNode)
  const persist = useGraphStore((s) => s.persist)
  const dirty = useGraphStore((s) => s.dirty)
  const loadAll = useGraphStore((s) => s.loadAll)

  const [scope, setScope] = useState('')
  const [report, setReport] = useState<ValidationReport | null>(null)
  const [tasks, setTasks] = useState<TaskList | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadAll().catch((e: Error) => setError(e.message))
  }, [loadAll])

  const addTable = () => {
    const offset = (Object.keys(useGraphStore.getState().graphs[activeLayer].nodes).length + 1) * 40
    addNode(activeLayer, {
      id: `n-${Date.now()}`,
      type: 'table',
      position: { x: 100 + offset, y: 100 + offset },
      data: { label: 'table', columns: [{ name: 'id', type: 'uuid', constraint: 'PRIMARY KEY' }] },
    })
  }

  const save = async () => {
    setError(null)
    try {
      await persist(activeLayer)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const validate = async () => {
    setBusy('validate')
    setError(null)
    try {
      setReport(await runValidate(scope))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const compile = async () => {
    setBusy('compile')
    setError(null)
    try {
      setTasks(await runCompile(scope))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>Visual Spec Builder</h1>
        <div className="tabs">
          {LAYERS.map(({ key, label }) => (
            <button
              key={key}
              className={`tab ${activeLayer === key ? 'tab--active' : ''}`}
              onClick={() => setActiveLayer(key)}
            >
              {label}
              {dirty[key] && <span className="tab__dot" title="unsaved" />}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <button onClick={addTable}>+ Table</button>
          <button onClick={save} disabled={!dirty[activeLayer]}>
            Save
          </button>
        </div>
      </header>

      <main className="app__body">
        <div className="canvas-wrap">
          <GraphCanvas layer={activeLayer} />
        </div>

        <aside className="side">
          <h2>Scope</h2>
          <textarea
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="Describe what you're building…"
            rows={4}
          />
          <div className="side__actions">
            <button onClick={validate} disabled={busy !== null || !scope.trim()}>
              {busy === 'validate' ? 'Validating…' : 'Validate'}
            </button>
            <button onClick={compile} disabled={busy !== null || !scope.trim()}>
              {busy === 'compile' ? 'Compiling…' : 'Compile → tasks.json'}
            </button>
          </div>

          {error && <p className="error">{error}</p>}

          {report && (
            <section>
              <h2>
                Validation{' '}
                <span className={report.passed ? 'ok' : 'fail'}>
                  {report.passed ? 'PASSED' : 'FAILED'}
                </span>
              </h2>
              {report.issues.length === 0 ? (
                <p>No issues.</p>
              ) : (
                <ul className="issues">
                  {report.issues.map((issue, i) => (
                    <li key={i} className={`issue issue--${issue.severity}`}>
                      <span className="issue__sev">{SEVERITY_LABEL[issue.severity]}</span>
                      <span>
                        {issue.node_id && <code>{issue.node_id}: </code>}
                        {issue.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tasks && (
            <section>
              <h2>Tasks ({tasks.tasks.length})</h2>
              <ol className="tasks">
                {tasks.tasks.map((task) => (
                  <li key={task.id}>
                    <strong>
                      {task.id} — {task.title}
                    </strong>
                    {task.description && <p>{task.description}</p>}
                    {task.depends_on.length > 0 && (
                      <p className="tasks__meta">depends on: {task.depends_on.join(', ')}</p>
                    )}
                    {task.files.length > 0 && (
                      <p className="tasks__meta">files: {task.files.join(', ')}</p>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </aside>
      </main>
    </div>
  )
}

export default App
