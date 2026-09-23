export type TraceEventKind = 'call' | 'line' | 'return' | 'call_site_truncated'
export type LocalKind = 'param' | 'body' | 'global'

// The structural shape returned by the backend's `capture_value()` — repr/id
// always present; the rest are only set when the value is a container (list/
// tuple/set/frozenset/dict) or a plain object instance, so the UI can show
// what's inside instead of a flat repr string.
export interface CapturedValue {
  repr: string
  id: number | null
  type?: string
  fields?: Record<string, CapturedValue>
  items?: CapturedValue[]
  entries?: { key: CapturedValue; value: CapturedValue }[]
  truncated?: boolean
  circular?: boolean
}

// A CapturedValue bound to a name in a frame's locals/globals — `kind` is
// bolted on by event_tracer.py only for locals, never present on a bare
// return value.
export interface LocalValue extends CapturedValue {
  kind: LocalKind
}

export interface TraceEvent {
  seq: number
  event: TraceEventKind
  frame_id: number | null
  parent_frame_id: number | null
  func: string
  file: string | null
  line: number | null
  call_line: number | null
  locals: Record<string, LocalValue>
  return_value: CapturedValue | null
  global_scope_id: number | null
  cap?: number
}

export interface TraceResult {
  events: TraceEvent[]
  // The frame_id of the traced function's own frame — usually 1, but when tracing an
  // instance method with constructor args, frame 1 is the constructor's own call (a
  // sibling, not a parent, since both are invoked separately from the tracer's
  // untraced driver frame), so the traced method's frame is pushed to frame 2+.
  entry_frame_id: number | null
  return_value: CapturedValue | null
  error: string | null
  truncated: boolean
}

export interface TraceRequestBody {
  file: string
  function: string
  args: string[]
}
