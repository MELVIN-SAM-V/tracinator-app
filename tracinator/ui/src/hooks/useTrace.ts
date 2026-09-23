import { useCallback, useState } from 'react'
import { buildTraceIndex, type TraceIndex } from '../lib/traceIndex'
import type { TraceResult } from '../types/trace'

export function useTrace() {
  const [result, setResult] = useState<TraceResult | null>(null)
  const [index, setIndex] = useState<TraceIndex | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runTraceRequest = useCallback((url: string, body: Record<string, unknown>) => {
    setLoading(true)
    setError(null)
    setResult(null)
    setIndex(null)

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({ detail: res.statusText }))
          throw new Error(errBody.detail ?? res.statusText)
        }
        return res.json() as Promise<TraceResult>
      })
      .then((data) => {
        setResult(data)
        setIndex(buildTraceIndex(data.events))
        setLoading(false)
        if (data.error) setError(data.error)
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  const runTrace = useCallback((file: string, fn: string, args: string[], constructorArgs: string[] = []) => {
    runTraceRequest('/api/trace', { file, function: fn, args, constructor_args: constructorArgs })
  }, [runTraceRequest])

  // Demo deployment only: the sandboxed Lambda backend is stateless across
  // invocations, so there's no shared temp file for it to trace by path —
  // it needs the actual source text, self-contained in this one request.
  const runTraceFromSource = useCallback((source: string, fn: string, args: string[], constructorArgs: string[] = []) => {
    runTraceRequest('/api/trace-from-source', { source, function: fn, args, constructor_args: constructorArgs })
  }, [runTraceRequest])

  const clearTrace = useCallback(() => {
    setResult(null)
    setIndex(null)
    setError(null)
    setLoading(false)
  }, [])

  return { result, index, loading, error, runTrace, runTraceFromSource, clearTrace }
}
