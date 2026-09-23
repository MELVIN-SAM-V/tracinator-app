import type { CapturedValue, LocalValue, TraceEvent } from '../types/trace'

export type FrameVarKey = string // `${frameId}:${name}`

export interface HistoryEntry {
  seq: number
  value: LocalValue
}

interface AliasChange {
  seq: number
  key: FrameVarKey
  bound: boolean // true = became live at this seq, false = stopped being live
}

export interface FrameSpan {
  startSeq: number
  endSeq: number | null
  func: string
  file: string | null
  parentFrameId: number | null
  callLine: number | null
  globalScopeId: number | null
  // What this frame returned — null until (unless) its 'return' event
  // fires. Stays null if the frame instead raised (no 'return' event is ever
  // emitted for an exception that propagates out of it).
  returnValue: CapturedValue | null
}

export type FrameLineKey = string // `${frameId}:${line}`

export interface TraceIndex {
  history: Map<FrameVarKey, HistoryEntry[]>
  aliasChanges: Map<number, AliasChange[]>
  frameSpans: Map<number, FrameSpan>
  callSites: Map<string, number[]>
  frameNames: Map<number, Set<string>>
  // Seqs to view a frame "as of having just finished" a given source line — see the
  // build loop below for why each is the *next* event's seq, not the line's own.
  // A line inside a loop is recorded once per pass, in execution order, so a
  // caller can resolve a specific iteration instead of only the last one.
  lineExitSeq: Map<FrameLineKey, number[]>
  // Every source line actually reached in each frame — lets the graph tell which
  // branch of an if/loop this trace took, to only animate the edge it followed.
  visitedLines: Map<number, Set<number>>
  maxSeq: number
}

export function frameVarKey(frameId: number, name: string): FrameVarKey {
  return `${frameId}:${name}`
}

export function parseFrameVarKey(key: FrameVarKey): { frameId: number; name: string } {
  const i = key.indexOf(':')
  return { frameId: Number(key.slice(0, i)), name: key.slice(i + 1) }
}

export function frameLineKey(frameId: number, line: number): FrameLineKey {
  return `${frameId}:${line}`
}

function callSiteKey(parentFrameId: number | null, callLine: number | null): string {
  return `${parentFrameId}:${callLine}`
}

export function buildTraceIndex(events: TraceEvent[]): TraceIndex {
  const history = new Map<FrameVarKey, HistoryEntry[]>()
  const aliasChanges = new Map<number, AliasChange[]>()
  const frameSpans = new Map<number, FrameSpan>()
  const callSites = new Map<string, number[]>()
  const frameNames = new Map<number, Set<string>>()
  const lineExitSeq = new Map<FrameLineKey, number[]>()
  const visitedLines = new Map<number, Set<number>>()
  // A 'line' event's own payload reflects everything that changed *before* reaching
  // it — sys.settrace's 'line' event fires just before that line runs. So the value
  // "right after line N finished" isn't attached to N's own event; it shows up on
  // whatever event comes next for that frame. Track each frame's last-seen line so
  // that when the next event arrives, we can record it as N's exit point.
  const lastLineByFrame = new Map<number, number>()
  // Tracks each variable's current object id so we only emit an alias change
  // when it actually changes — avoids re-deriving this from `history` on
  // every capture, and keeps rebind/unbind correct without duplicate entries.
  const currentId = new Map<FrameVarKey, number | null>()
  let maxSeq = 0

  const pushAliasChange = (objectId: number, key: FrameVarKey, seq: number, bound: boolean) => {
    const list = aliasChanges.get(objectId)
    if (list) list.push({ seq, key, bound })
    else aliasChanges.set(objectId, [{ seq, key, bound }])
  }

  const recordCapture = (key: FrameVarKey, value: CapturedValue, seq: number) => {
    const prevId = currentId.get(key) ?? null
    if (prevId !== value.id) {
      if (prevId !== null) pushAliasChange(prevId, key, seq, false)
      if (value.id !== null) pushAliasChange(value.id, key, seq, true)
      currentId.set(key, value.id)
    }
  }

  const unbindFrame = (frameId: number, seq: number) => {
    const names = frameNames.get(frameId)
    if (!names) return
    for (const name of names) {
      const key = frameVarKey(frameId, name)
      const prevId = currentId.get(key) ?? null
      if (prevId !== null) {
        pushAliasChange(prevId, key, seq, false)
        currentId.set(key, null)
      }
    }
  }

  for (const event of events) {
    maxSeq = event.seq

    if (event.frame_id === null) continue // e.g. call_site_truncated marker

    const prevLine = lastLineByFrame.get(event.frame_id)
    if (prevLine != null) {
      const key = frameLineKey(event.frame_id, prevLine)
      const seqs = lineExitSeq.get(key)
      if (seqs) seqs.push(event.seq)
      else lineExitSeq.set(key, [event.seq])
    }
    if (event.line != null) {
      lastLineByFrame.set(event.frame_id, event.line)
      let lines = visitedLines.get(event.frame_id)
      if (!lines) {
        lines = new Set()
        visitedLines.set(event.frame_id, lines)
      }
      lines.add(event.line)
    }

    if (event.event === 'call') {
      frameSpans.set(event.frame_id, {
        startSeq: event.seq,
        endSeq: null,
        func: event.func,
        file: event.file,
        parentFrameId: event.parent_frame_id,
        callLine: event.call_line,
        globalScopeId: event.global_scope_id,
        returnValue: null,
      })
      const key = callSiteKey(event.parent_frame_id, event.call_line)
      const occurrences = callSites.get(key)
      if (occurrences) occurrences.push(event.frame_id)
      else callSites.set(key, [event.frame_id])
    }

    for (const [name, value] of Object.entries(event.locals)) {
      const key = frameVarKey(event.frame_id, name)
      let names = frameNames.get(event.frame_id)
      if (!names) {
        names = new Set()
        frameNames.set(event.frame_id, names)
      }
      names.add(name)

      const entry: HistoryEntry = { seq: event.seq, value }
      const list = history.get(key)
      if (list) list.push(entry)
      else history.set(key, [entry])

      recordCapture(key, value, event.seq)
    }

    if (event.event === 'return') {
      const span = frameSpans.get(event.frame_id)
      if (span) {
        span.endSeq = event.seq
        span.returnValue = event.return_value
      }
      unbindFrame(event.frame_id, event.seq)
    }
  }

  return { history, aliasChanges, frameSpans, callSites, frameNames, lineExitSeq, visitedLines, maxSeq }
}
