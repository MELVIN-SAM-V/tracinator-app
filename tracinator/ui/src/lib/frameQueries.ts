import type { LocalValue } from '../types/trace'
import { frameLineKey, frameVarKey, parseFrameVarKey, type FrameVarKey, type HistoryEntry, type TraceIndex } from './traceIndex'

// What point in a frame's execution to view its variables as of.
export type ViewPoint = { kind: 'entry' } | { kind: 'exit' } | { kind: 'line'; line: number }

export interface FrameStateSections {
  global: Record<string, LocalValue>
  param: Record<string, LocalValue>
  body: Record<string, LocalValue>
}

function latestAtOrBefore(entries: HistoryEntry[], atSeq: number): HistoryEntry | undefined {
  let result: HistoryEntry | undefined
  for (const entry of entries) {
    if (entry.seq > atSeq) break
    result = entry
  }
  return result
}

/**
 * The seq to view a frame "as of" — its own return event if it has one, else the end
 * of the whole trace. A full trace is a finished post-hoc replay, so "the very end of
 * the program" isn't a useful "now" for an already-returned frame; "when this call
 * itself finished" is the well-defined moment that both its own Global/Caller/State
 * and any shared-identity lookups should reflect.
 */
export function frameViewSeq(index: TraceIndex, frameId: number): number {
  return index.frameSpans.get(frameId)?.endSeq ?? index.maxSeq
}

/** The seq to view a frame "as of" its own entry — right when it was called, before any of its own lines ran. */
export function frameEntrySeq(index: TraceIndex, frameId: number): number {
  return index.frameSpans.get(frameId)?.startSeq ?? 0
}

/**
 * The seq to view a frame "as of" having just finished a given source line — null if
 * that line never ran in this frame this trace (e.g. a branch that wasn't taken). A
 * line inside a loop ran more than once, so `afterSeq` (the trace position we're
 * stepping from) picks which pass: the first one that finished at or after it, falling
 * back to the last pass if we're stepping from beyond all of them. Without a cursor
 * (`afterSeq` null, e.g. a fresh click with no prior position), defaults to the last
 * pass — the pre-existing behavior for lines that only ran once.
 */
export function frameLineSeq(index: TraceIndex, frameId: number, line: number, afterSeq: number | null = null): number | null {
  const seqs = index.lineExitSeq.get(frameLineKey(frameId, line))
  if (!seqs || seqs.length === 0) return null
  if (afterSeq == null) return seqs[seqs.length - 1]
  for (const seq of seqs) {
    if (seq >= afterSeq) return seq
  }
  return seqs[seqs.length - 1]
}

/** Resolves a `ViewPoint` to a concrete seq for `frameId` — null if that point has no data yet. */
export function resolveViewSeq(index: TraceIndex, frameId: number, viewPoint: ViewPoint, afterSeq: number | null = null): number | null {
  switch (viewPoint.kind) {
    case 'entry':
      return frameEntrySeq(index, frameId)
    case 'exit':
      return frameViewSeq(index, frameId)
    case 'line':
      return frameLineSeq(index, frameId, viewPoint.line, afterSeq)
  }
}

function collectInto(index: TraceIndex, sections: FrameStateSections, ownerFrameId: number, atSeq: number): void {
  const names = index.frameNames.get(ownerFrameId)
  if (!names) return
  for (const name of names) {
    const entries = index.history.get(frameVarKey(ownerFrameId, name))
    const latest = entries && latestAtOrBefore(entries, atSeq)
    if (!latest) continue
    sections[latest.value.kind][name] = latest.value
  }
}

/**
 * State of one frame's variables — bucketed into Global/Caller("param")/State("body") —
 * as of `atSeq` (default: latest known). A function frame's own captured names never
 * include "global" — those live under a separate module-scope frame id (see
 * `global_scope_id` / `FrameSpan.globalScopeId`) — so this also merges in whichever
 * global scope owns `frameId`, if any.
 */
export function getFrameState(index: TraceIndex, frameId: number, atSeq: number = Infinity): FrameStateSections {
  const sections: FrameStateSections = { global: {}, param: {}, body: {} }
  const span = index.frameSpans.get(frameId)
  if (span && atSeq < span.startSeq) return sections // frame hasn't been called yet at this point in the trace

  collectInto(index, sections, frameId, atSeq)
  if (span?.globalScopeId != null) collectInto(index, sections, span.globalScopeId, atSeq)
  return sections
}

/** Ancestor chain from the entry frame down to (not including) `frameId`. Empty for the entry frame itself. */
export function getAncestorChain(index: TraceIndex, frameId: number): number[] {
  const chain: number[] = []
  let current = index.frameSpans.get(frameId)?.parentFrameId ?? null
  while (current !== null) {
    chain.push(current)
    current = index.frameSpans.get(current)?.parentFrameId ?? null
  }
  return chain.reverse()
}

/** Every runtime invocation spawned from one static call site, in call order (for the occurrence stepper). */
export function getOccurrences(index: TraceIndex, parentFrameId: number | null, callLine: number | null): number[] {
  return index.callSites.get(`${parentFrameId}:${callLine}`) ?? []
}

/**
 * Index into `occurrences` of the call nearest-after `afterSeq` — e.g. stepping "next"
 * from partway through a loop's second pass lands on that pass's own nested calls,
 * not always the loop's first pass. Falls back to the last occurrence if `afterSeq` is
 * past all of them, or the first if there's no cursor yet (a fresh, undirected click).
 */
export function nearestOccurrenceIndex(index: TraceIndex, occurrences: number[], afterSeq: number | null): number {
  if (afterSeq == null) return 0
  for (let i = 0; i < occurrences.length; i++) {
    const span = index.frameSpans.get(occurrences[i])
    if (span && span.startSeq >= afterSeq) return i
  }
  return occurrences.length - 1
}

export interface AliasBinding {
  frameId: number
  name: string
}

/** Every (frame, variable) currently holding `objectId` as of `atSeq` (default: end of trace) — powers the shared-identity badge. */
export function getLiveAliases(index: TraceIndex, objectId: number, atSeq: number = Infinity): AliasBinding[] {
  const changes = index.aliasChanges.get(objectId)
  if (!changes) return []
  const live = new Set<FrameVarKey>()
  for (const change of changes) {
    if (change.seq > atSeq) break
    if (change.bound) live.add(change.key)
    else live.delete(change.key)
  }
  return Array.from(live, parseFrameVarKey)
}

/**
 * `getLiveAliases`, excluding one specific (frame, variable) binding — for a shared-
 * identity badge on that exact binding's own row. Needed because a frame's own unbind
 * (on return) fires at the same seq as `frameViewSeq` uses to view that same frame's
 * own state, so a frame querying its own binding at its own end-of-life would otherwise
 * always find itself already removed. The row being rendered always counts as "self";
 * this answers "besides that, who else is currently holding it."
 */
export function getOtherLiveAliases(
  index: TraceIndex,
  objectId: number,
  atSeq: number,
  selfFrameId: number,
  selfName: string,
): AliasBinding[] {
  return getLiveAliases(index, objectId, atSeq).filter((a) => !(a.frameId === selfFrameId && a.name === selfName))
}
