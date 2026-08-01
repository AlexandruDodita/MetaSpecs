import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirListing } from '../types'
import { listDirs } from '../api'

interface DirectoryPickerProps {
  initialPath?: string
  onChoose: (path: string) => void
  onCancel: () => void
}

export function DirectoryPicker({ initialPath, onChoose, onCancel }: DirectoryPickerProps) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [typed, setTyped] = useState('')

  const currentPath = useRef(initialPath ?? '')

  const go = useCallback(
    async (path: string) => {
      setLoading(true)
      try {
        const next = await listDirs(path, showHidden)
        currentPath.current = next.path
        setListing(next)
        setTyped(next.path)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [showHidden],
  )

  useEffect(() => {
    void go(currentPath.current)
  }, [go])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const crumbs = listing
    ? listing.path
        .split('/')
        .filter(Boolean)
        .reduce<{ name: string; path: string }[]>((out, part) => {
          const prev = out.length > 0 ? out[out.length - 1].path : ''
          out.push({ name: part, path: `${prev}/${part}` })
          return out
        }, [])
    : []

  return (
    <div className="dir-picker__backdrop">
      <div className="dir-picker">
        <div className="dir-picker__header">
          <h2>Choose a folder</h2>
          <button type="button" className="dir-picker__close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="dir-picker__toolbar">
          <button type="button" onClick={() => go(listing!.home)} disabled={!listing}>
            Home
          </button>
          <button
            type="button"
            onClick={() => go(listing!.parent!)}
            disabled={!listing || !listing.parent}
          >
            Up
          </button>
          <label className="dir-picker__hidden">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            show hidden
          </label>
        </div>

        {listing && (
          <div className="dir-picker__crumbs">
            <button type="button" onClick={() => go('/')}>
              /
            </button>
            {crumbs.map((crumb) => (
              <button type="button" key={crumb.path} onClick={() => go(crumb.path)}>
                {crumb.name}
              </button>
            ))}
          </div>
        )}

        {error && <p className="dir-picker__error">{error}</p>}

        <ul className="dir-picker__list">
          {loading ? (
            <li className="dir-picker__empty">Loading…</li>
          ) : listing && listing.entries.length === 0 ? (
            <li className="dir-picker__empty">No sub-folders here.</li>
          ) : null}
          {listing?.entries.map((entry) => (
            <li key={entry.path} className="dir-picker__row">
              <button type="button" onClick={() => go(entry.path)}>
                {entry.name}
                {entry.is_repo && <span className="dir-picker__badge">git</span>}
              </button>
            </li>
          ))}
          {listing?.truncated && (
            <li className="dir-picker__empty">Showing the first 1000 folders.</li>
          )}
        </ul>

        <div className="dir-picker__footer">
          <code>{listing?.path ?? ''}</code>
          <form
            className="dir-picker__jump"
            onSubmit={(e) => {
              e.preventDefault()
              go(typed)
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Paste a path…"
              spellCheck={false}
            />
            <button type="submit">Go</button>
          </form>
          <div className="dir-picker__actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="dir-picker__primary"
              onClick={() => onChoose(listing!.path)}
              disabled={loading || listing === null}
            >
              Use this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
