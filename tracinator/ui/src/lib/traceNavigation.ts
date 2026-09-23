import { getAncestorChain, getOccurrences, nearestOccurrenceIndex } from './frameQueries'
import type { TraceIndex } from './traceIndex'

export interface CallSite {
  parentFrameId: number | null
  callLine: number | null
}

export interface NavigationState {
  frameId: number
  occurrenceIndex: number
  occurrences: number[]
}

/**
 * Resolve "navigate into this call site" to a concrete frame — the occurrence
 * nearest-after `afterSeq` (where we were just viewing, e.g. mid-loop), or the first
 * occurrence if there's no cursor yet.
 */
export function navigateIntoCall(index: TraceIndex, callSite: CallSite, afterSeq: number | null = null): NavigationState | null {
  const occurrences = getOccurrences(index, callSite.parentFrameId, callSite.callLine)
  if (occurrences.length === 0) return null
  const occurrenceIndex = nearestOccurrenceIndex(index, occurrences, afterSeq)
  return { frameId: occurrences[occurrenceIndex], occurrenceIndex, occurrences }
}

/** Step to another occurrence of the same call site ("call 2 of 5"). Clamped to the valid range. */
export function stepOccurrence(state: NavigationState, delta: number): NavigationState {
  const nextIndex = Math.max(0, Math.min(state.occurrenceIndex + delta, state.occurrences.length - 1))
  return { ...state, occurrenceIndex: nextIndex, frameId: state.occurrences[nextIndex] }
}

/** Navigate to one specific ancestor frame (e.g. clicked in the Call-stack breadcrumb / a shared-badge popover entry). */
export function navigateToFrame(index: TraceIndex, frameId: number): NavigationState {
  const span = index.frameSpans.get(frameId)
  const occurrences = getOccurrences(index, span?.parentFrameId ?? null, span?.callLine ?? null)
  const occurrenceIndex = occurrences.indexOf(frameId)
  return {
    frameId,
    occurrenceIndex: occurrenceIndex >= 0 ? occurrenceIndex : 0,
    occurrences: occurrences.length ? occurrences : [frameId],
  }
}

/** Full breadcrumb for the currently-viewed frame: entry frame first, current frame last. */
export function getBreadcrumb(index: TraceIndex, frameId: number): number[] {
  return [...getAncestorChain(index, frameId), frameId]
}
