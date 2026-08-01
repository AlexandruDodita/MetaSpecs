import { useEffect } from 'react'
import { useGraphStore } from './store'
import type { Layer } from './types'

export function useAutosave(delayMs = 800) {
  const dirty = useGraphStore((s) => s.dirty)

  useEffect(() => {
    const layers = (Object.keys(dirty) as Layer[]).filter((l) => dirty[l])
    if (layers.length === 0) return
    const timer = window.setTimeout(() => {
      void useGraphStore.getState().persistDirty().catch(() => {})
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [dirty, delayMs])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const { dirty } = useGraphStore.getState()
      const hasDirty = (Object.keys(dirty) as Layer[]).some((l) => dirty[l])
      if (!hasDirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])
}
