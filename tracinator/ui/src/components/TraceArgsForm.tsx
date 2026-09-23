import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eraser, Maximize2, Minimize2, Play, X } from 'lucide-react'
import type { FunctionInfo } from '../types/graph'
import Onboarding from './Onboarding'

const MAX_TEXTAREA_HEIGHT = 240
const MIN_TEXTAREA_HEIGHT = 30

// Public demo build: no real file for /api/source to read (see the effect below),
// so the signature lookup uses the pasted source text passed in directly instead.
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true'
// First-time-only coachmark explaining that these fields are real Python source,
// not free text — shown once per browser, next to whichever field renders first.
const VALUE_TIP_SEEN_KEY = 'tracinator_value_tip_seen'

type FieldKind = 'arg' | 'ctor'
const fieldKey = (kind: FieldKind, name: string) => `${kind}:${name}`

interface Props {
  file: string
  fn: string
  // Demo build only: the pasted source itself, used in place of an /api/source
  // fetch (there's no real file on disk for the sandboxed backend to read).
  source?: string
  // Values from the last trace run of this same function, if any — pre-fills the
  // form instead of making the user retype what they just ran.
  initialArgs?: string[]
  initialConstructorArgs?: string[]
  onClose: () => void
  onSubmit: (args: string[], constructorArgs: string[]) => void
}

export default function TraceArgsForm({ file, fn, source, initialArgs, initialConstructorArgs, onClose, onSubmit }: Props) {
  const [match, setMatch] = useState<FunctionInfo | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [ctorValues, setCtorValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  // Manually shrunk back down after auto-growing too large — re-expands on the next edit.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const [showValueTip, setShowValueTip] = useState(() => DEMO_MODE && !localStorage.getItem(VALUE_TIP_SEEN_KEY))
  const dismissValueTip = () => {
    setShowValueTip(false)
    localStorage.setItem(VALUE_TIP_SEEN_KEY, '1')
  }

  const resize = (key: string) => {
    const el = textareaRefs.current[key]
    if (!el) return
    if (collapsed.has(key)) {
      el.style.height = `${MIN_TEXTAREA_HEIGHT}px`
    } else {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
    }
  }

  useEffect(() => {
    Object.keys(textareaRefs.current).forEach(resize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed])

  useEffect(() => {
    setMatch(null)
    setError(null)

    // Demo build: the sandboxed backend has no filesystem for /api/source to read
    // (the traced file is a per-request tempfile, already deleted by the time this
    // form opens), but the pasted source is already in hand — go straight to
    // /api/functions-from-source with it.
    //
    // Local build: not /api/functions?file=... — that endpoint rejects anything
    // outside the configured project root, but the file being traced may be a temp
    // file (e.g. the Editor tab builds its graph from one). /api/source has no such
    // restriction (it just reads whatever path exists), so fetch the raw text first
    // and reuse /api/functions-from-source (the same call EditorPane already makes).
    const sourceText = DEMO_MODE
      ? Promise.resolve(source ?? '')
      : fetch(`/api/source?file=${encodeURIComponent(file)}`)
          .then(async (r) => {
            if (!r.ok) throw new Error()
            return r.json() as Promise<{ lines: string[] }>
          })
          .then(({ lines }) => lines.join('\n'))

    sourceText
      .then((src) =>
        fetch('/api/functions-from-source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: src }),
        }),
      )
      .then((r) => r.json())
      .then((data: { functions: FunctionInfo[] }) => {
        const found = data.functions.find((f) => f.qualified_name === fn)
        if (!found) {
          setError(`Function "${fn}" not found`)
          return
        }
        setMatch(found)
        setValues(Object.fromEntries(found.args.map((a, i) => [a, initialArgs?.[i] ?? ''])))
        setCtorValues(
          Object.fromEntries((found.constructor_args ?? []).map((a, i) => [a, initialConstructorArgs?.[i] ?? ''])),
        )
      })
      .catch(() => setError('Failed to load function signature'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, fn, source])

  // Pre-filled values (from initialArgs) can already be multi-line, so they need the
  // same auto-grow pass a keystroke would trigger — but that only runs on `collapsed`
  // changes, which haven't happened yet the first time `match` becomes non-null.
  useEffect(() => {
    Object.keys(textareaRefs.current).forEach(resize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match])

  // __init__ IS the constructor — its own params and "the constructor's params"
  // are the same list, so there's nothing separate to ask for twice.
  const showConstructorArgs = match?.method_kind === 'instance' && match.name !== '__init__'
  const params = match?.args ?? null
  const ctorParams = match?.constructor_args ?? []

  // Whichever field renders first (constructor args take priority when shown) —
  // the value-typing coachmark points at this one.
  const firstFieldKey =
    showConstructorArgs && ctorParams.length > 0
      ? fieldKey('ctor', ctorParams[0])
      : params && params.length > 0
        ? fieldKey('arg', params[0])
        : null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!params) return
    onSubmit(
      params.map((p) => values[p] ?? ''),
      showConstructorArgs ? ctorParams.map((p) => ctorValues[p] ?? '') : [],
    )
  }

  const handleClearAll = () => {
    if (!params) return
    setValues(Object.fromEntries(params.map((p) => [p, ''])))
    setCtorValues(Object.fromEntries(ctorParams.map((p) => [p, ''])))
    setCollapsed(new Set()) // new reference — forces the resize effect to re-run and shrink every field back down
  }

  const renderField = (
    kind: FieldKind,
    p: string,
    i: number,
    valueMap: Record<string, string>,
    setValueMap: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  ) => {
    const key = fieldKey(kind, p)
    const isMultiline = (valueMap[p] ?? '').includes('\n')
    const isCollapsed = collapsed.has(key)
    return (
      <label key={key} className="flex flex-col gap-1 text-xs text-gray-400">
        <div className="flex items-center justify-between">
          <span>{p}</span>
          {(isMultiline || isCollapsed) && (
            <button
              type="button"
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(key)) next.delete(key)
                  else next.add(key)
                  return next
                })
              }
              title={isCollapsed ? 'Expand' : 'Collapse'}
              className="text-gray-500 hover:text-indigo-300 transition-colors"
            >
              {isCollapsed ? <Maximize2 size={11} /> : <Minimize2 size={11} />}
            </button>
          )}
        </div>
        <textarea
          ref={(el) => { textareaRefs.current[key] = el }}
          data-tour={key === firstFieldKey ? 'tour-value-field' : undefined}
          autoFocus={kind === (showConstructorArgs ? 'ctor' : 'arg') && i === 0}
          value={valueMap[p] ?? ''}
          onChange={(e) => {
            const val = e.target.value
            setValueMap((v) => ({ ...v, [p]: val }))
            if (!isCollapsed) {
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
            }
          }}
          placeholder="e.g. 500.0 or 'u1' or&#10;{&#10;  &quot;a&quot;: 1,&#10;  &quot;b&quot;: 2&#10;}"
          rows={1}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 text-xs font-mono focus:outline-none focus:border-indigo-500 resize-none whitespace-pre overflow-y-auto min-h-[30px] transition-[height] duration-100"
        />
      </label>
    )
  }

  // Portalled straight to <body> — the toolbar this is opened from has backdrop-blur,
  // which (like filter/transform) creates a new containing block for `position: fixed`
  // descendants. Rendered as a normal child, this modal would center itself inside the
  // 48px toolbar bar instead of the viewport, clipping its top off-screen.
  return (
    <>
      {createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-5 w-[380px] max-h-[85vh] shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4 shrink-0">
              <h2 className="text-sm font-semibold text-gray-200">
                Trace{' '}
                <span className="text-indigo-300 font-mono">
                  {match?.class_name ? `${match.class_name}.${match.name}` : fn}()
                </span>
              </h2>
              <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
                <X size={16} />
              </button>
            </div>

            {error && <p className="text-red-400 text-xs mb-3 shrink-0">{error}</p>}
            {!error && !params && <p className="text-gray-500 text-xs">Loading signature…</p>}

            {/* Fields scroll internally, capped by the box's own max-h-[85vh] — otherwise
                several auto-grown multi-line values can push the header/close button and
                the footer buttons off-screen with no way to reach them. */}
            {params && (
              <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
                <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1">
                  {showConstructorArgs && (
                    <div className="flex flex-col gap-3">
                      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                        Constructor arguments
                      </p>
                      {ctorParams.length === 0 && (
                        <p className="text-gray-500 text-xs italic">No constructor arguments.</p>
                      )}
                      {ctorParams.map((p, i) => renderField('ctor', p, i, ctorValues, setCtorValues))}
                      <div className="border-t border-gray-800 pt-1" />
                      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                        Method arguments
                      </p>
                    </div>
                  )}
                  {params.length === 0 && (
                    <p className="text-gray-500 text-xs italic">No parameters — ready to trace.</p>
                  )}
                  {params.map((p, i) => renderField('arg', p, i, values, setValues))}
                </div>
                <div className="mt-3 pt-3 border-t border-gray-800 flex items-center gap-2 shrink-0">
                  {(params.length > 0 || ctorParams.length > 0) && (
                    <button
                      type="button"
                      onClick={handleClearAll}
                      title="Clear all values"
                      className="flex items-center justify-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs font-medium rounded px-3 py-2 transition-colors"
                    >
                      <Eraser size={12} /> Clear
                    </button>
                  )}
                  <button
                    type="submit"
                    className="flex-1 flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded px-3 py-2 transition-colors"
                  >
                    <Play size={12} /> Run trace
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>,
        document.body,
      )}

      {showValueTip && firstFieldKey && (
        <Onboarding
          steps={[
            {
              selector: '[data-tour="tour-value-field"]',
              message: "These fields are real Python — strings need quotes. Type 'anage', not anage, or it's read as an unknown variable.",
              placement: 'bottom',
            },
          ]}
          onDone={dismissValueTip}
        />
      )}
    </>
  )
}
