import { useCallback, useEffect, useRef, useState } from 'react'
import type { TraceIndex } from '../lib/traceIndex'
import { frameViewSeq, resolveViewSeq, type ViewPoint } from '../lib/frameQueries'
import {
  getBreadcrumb,
  navigateIntoCall as navigateIntoCallLib,
  navigateToFrame as navigateToFrameLib,
  type NavigationState,
} from '../lib/traceNavigation'

export type { ViewPoint } from '../lib/frameQueries'

const EXIT_VIEW: ViewPoint = { kind: 'exit' }

// `depth` is the graph's own navStack length — passed through so that if a trace is
// (re)run while several calls deep in the graph, the base-frame stack below starts
// aligned with that depth instead of assuming the trace root is the graph root.
// `entryFrameId` is the traced function's own frame_id — usually 1, but not when
// tracing an instance method with constructor args (see types/trace.ts).
export function useTraceView(index: TraceIndex | null, depth: number, entryFrameId: number = 1) {
  const [nav, setNav] = useState<NavigationState | null>(null)
  // True right after a click resolves to a point with no data this run (e.g. a call
  // or a line that didn't execute) — lets the panel say so instead of silently
  // staying on whatever was showing before.
  const [notFound, setNotFound] = useState(false)
  // Which snapshot of the current frame to show: at entry, at exit, or right after a
  // specific source line last ran (see resolveViewSeq).
  const [viewPoint, setViewPoint] = useState<ViewPoint>(EXIT_VIEW)
  // The concrete seq `viewPoint` resolved to, captured at the moment it was set (a
  // loop-body line has more than one candidate seq — see frameLineSeq — so this pins
  // down which pass we're actually looking at instead of re-deriving it later with no
  // cursor and silently landing back on the default/last pass). Doubles as the cursor
  // "next" steps resolve from, so stepping onward from a specific loop pass or call
  // occurrence continues from there instead of resetting to the first.
  const [viewSeq, setViewSeq] = useState<number | null>(null)
  // One entry per graph-navigation depth: the trace frame "owning" the function
  // currently displayed at that depth. A CALL-node click always resolves against the
  // *top* of this stack, not against `nav` — `nav` moves on every single click (to
  // whatever call was last peeked at), so using it as the resolution parent would mean
  // clicking one call and then a sibling call resolves the second click against the
  // first call's frame instead of their shared parent, silently failing to find it.
  // null at a depth means that depth has no trace coverage (e.g. an unexecuted branch).
  const depthRef = useRef(depth)
  useEffect(() => {
    depthRef.current = depth
  }, [depth])
  const [baseFrameStack, setBaseFrameStack] = useState<(number | null)[]>([])

  useEffect(() => {
    setNav(index ? navigateToFrameLib(index, entryFrameId) : null)
    setNotFound(false)
    setViewPoint(EXIT_VIEW)
    setViewSeq(index ? frameViewSeq(index, entryFrameId) : null)
    const d = depthRef.current
    setBaseFrameStack(index ? [...Array(Math.max(d - 1, 0)).fill(null), entryFrameId] : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, entryFrameId])

  const baseFrameId = baseFrameStack.length ? baseFrameStack[baseFrameStack.length - 1] : null

  // Single click on a CALL node: peek its callee's variables. Leaves the base frame
  // (and thus what future sibling clicks resolve against) untouched. Resolves against
  // `viewSeq` — wherever we were just looking — so a repeated call site lands on the
  // occurrence nearest-after that point instead of always the first. `atSeq` overrides
  // that cursor with an exact target (e.g. graph arrow-key nav jumping straight to a
  // specific occurrence, including backward, which the implicit cursor can't do since
  // it only ever resolves forward).
  const peekCall = useCallback(
    (callLine: number, atSeq?: number) => {
      if (!index || baseFrameId == null) return
      const next = navigateIntoCallLib(index, { parentFrameId: baseFrameId, callLine }, atSeq ?? viewSeq)
      if (next) {
        setNav(next)
        setNotFound(false)
        setViewPoint(EXIT_VIEW)
        setViewSeq(frameViewSeq(index, next.frameId))
      } else {
        setNotFound(true)
      }
    },
    [index, baseFrameId, viewSeq],
  )

  // Double click / "Navigate into": drills the graph in, and pushes a new base frame
  // for that depth so clicks inside the callee's own body resolve correctly.
  const enterCall = useCallback(
    (callLine: number) => {
      if (!index || baseFrameId == null) {
        setBaseFrameStack((prev) => [...prev, null])
        return
      }
      const next = navigateIntoCallLib(index, { parentFrameId: baseFrameId, callLine }, viewSeq)
      setBaseFrameStack((prev) => [...prev, next?.frameId ?? null])
      if (next) {
        setNav(next)
        setNotFound(false)
        setViewPoint(EXIT_VIEW)
        setViewSeq(frameViewSeq(index, next.frameId))
      } else {
        setNotFound(true)
      }
    },
    [index, baseFrameId, viewSeq],
  )

  // ENTRY/EXIT/any other node click: these belong to the currently displayed function
  // itself, not to whatever call was last peeked at — so unlike peekCall, this must
  // snap `nav` back to the base frame (not leave it on a previously-peeked callee).
  // If the requested point never ran this trace (e.g. a branch not taken), leaves
  // `nav`/`viewPoint` untouched and just flags notFound, same as a failed peekCall.
  // The cursor only applies when we're already sitting on the base frame itself —
  // once `nav` has drifted to a peeked callee, that callee's position says nothing
  // useful about which pass of a loop line in the *base* frame comes next. `atSeq`
  // overrides that cursor with an exact target pass, same as peekCall above.
  const viewBaseFrame = useCallback(
    (point: ViewPoint, atSeq?: number) => {
      if (!index || baseFrameId == null) return
      const afterSeq = atSeq ?? (nav?.frameId === baseFrameId ? viewSeq : null)
      const resolved = resolveViewSeq(index, baseFrameId, point, afterSeq)
      if (resolved == null) {
        setNotFound(true)
        return
      }
      setNav(navigateToFrameLib(index, baseFrameId))
      setNotFound(false)
      setViewPoint(point)
      setViewSeq(resolved)
    },
    [index, baseFrameId, nav, viewSeq],
  )

  // "Back" / graph breadcrumb: pop the base-frame stack to match, and show that
  // depth's own frame if the trace reached it.
  const exitToDepth = useCallback(
    (targetDepth: number) => {
      const frameId = baseFrameStack[targetDepth] ?? null
      setBaseFrameStack((prev) => prev.slice(0, targetDepth + 1))
      if (index && frameId != null) {
        setNotFound(false)
        setViewPoint(EXIT_VIEW)
        setNav(navigateToFrameLib(index, frameId))
        setViewSeq(frameViewSeq(index, frameId))
      }
    },
    [index, baseFrameStack],
  )

  // Direct index, not a delta — lets the user pick any occurrence, or step back to an earlier one.
  const jumpToOccurrence = useCallback(
    (occurrenceIndex: number) => {
      if (!index || !nav) return
      const clamped = Math.max(0, Math.min(occurrenceIndex, nav.occurrences.length - 1))
      const frameId = nav.occurrences[clamped]
      setNotFound(false)
      setViewPoint(EXIT_VIEW)
      setNav({ ...nav, occurrenceIndex: clamped, frameId })
      setViewSeq(frameViewSeq(index, frameId))
    },
    [index, nav],
  )

  const navigateToFrame = useCallback(
    (frameId: number) => {
      if (!index) return
      setNotFound(false)
      setViewPoint(EXIT_VIEW)
      setNav(navigateToFrameLib(index, frameId))
      setViewSeq(frameViewSeq(index, frameId))
    },
    [index],
  )

  const breadcrumb = index && nav ? getBreadcrumb(index, nav.frameId) : []

  return {
    nav,
    breadcrumb,
    notFound,
    viewPoint,
    // The concrete seq `viewPoint` resolved to — see the state comment above. Lets the
    // panel show exactly the pass that was resolved, without re-deriving it with no
    // cursor and landing on a different (default) pass for a multi-visit line.
    viewSeq,
    // The trace frame behind the currently displayed function — lets the graph know
    // which branches actually ran, to only animate the edge that trace took.
    baseFrameId,
    peekCall,
    enterCall,
    viewBaseFrame,
    exitToDepth,
    jumpToOccurrence,
    navigateToFrame,
  }
}
