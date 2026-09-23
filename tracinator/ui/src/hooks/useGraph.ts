import { useState, useCallback } from 'react'
import { PyProjectContext, TracinatorConfig } from '../types/graph'

export function useGraph() {
  const [context, setContext] = useState<PyProjectContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadGraph = useCallback((config: TracinatorConfig) => {
    setLoading(true)
    setError(null)
    setContext(null)

    const params = new URLSearchParams({
      file: config.file,
      function: config.function,
      depth: String(config.depth ?? 3),
      root: config.root ?? '',
    })

    fetch(`/api/graph?${params}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ detail: res.statusText }))
          throw new Error(body.detail ?? res.statusText)
        }
        return res.json() as Promise<PyProjectContext>
      })
      .then((data) => { setContext(data); setLoading(false) })
      .catch((err: Error) => { setError(err.message); setLoading(false) })
  }, [])

  const loadGraphFromSource = useCallback((source: string, fn: string, depth = 3) => {
    setLoading(true)
    setError(null)
    setContext(null)

    fetch('/api/graph-from-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, function: fn, depth }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ detail: res.statusText }))
          throw new Error(body.detail ?? res.statusText)
        }
        return res.json() as Promise<PyProjectContext>
      })
      .then((data) => { setContext(data); setLoading(false) })
      .catch((err: Error) => { setError(err.message); setLoading(false) })
  }, [])

  const clearGraph = useCallback(() => {
    setContext(null)
    setError(null)
    setLoading(false)
  }, [])

  return { context, loading, error, loadGraph, loadGraphFromSource, clearGraph }
}
