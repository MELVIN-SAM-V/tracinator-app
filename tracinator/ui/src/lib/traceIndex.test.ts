import { describe, expect, it } from 'vitest'
import type { CapturedValue, LocalValue, TraceEvent } from '../types/trace'
import { buildTraceIndex, frameLineKey, frameVarKey } from './traceIndex'

let seqCounter = 0
function resetSeq() {
  seqCounter = 0
}
function ev(
  partial: Partial<Omit<TraceEvent, 'return_value'>> &
    Pick<TraceEvent, 'event' | 'frame_id' | 'func'> & { return_value?: string | null },
): TraceEvent {
  const { return_value, ...rest } = partial
  return {
    seq: seqCounter++,
    parent_frame_id: null,
    file: 'f.py',
    line: 1,
    call_line: null,
    locals: {},
    return_value: return_value === undefined ? null : return_value === null ? null : retval(return_value),
    global_scope_id: null,
    ...rest,
  }
}
function local(repr: string, id: number | null, kind: LocalValue['kind']): LocalValue {
  return { repr, id, kind }
}
function retval(repr: string): CapturedValue {
  return { repr, id: null }
}

describe('buildTraceIndex — call tree structure', () => {
  it('records a frameSpan per call, with start/end seq', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'main' }),
      ev({ event: 'call', frame_id: 2, func: 'helper', parent_frame_id: 1, call_line: 10 }),
      ev({ event: 'return', frame_id: 2, func: 'helper', parent_frame_id: 1, call_line: 10, return_value: '1' }),
      ev({ event: 'return', frame_id: 1, func: 'main', return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    expect(index.frameSpans.get(1)).toMatchObject({ startSeq: 0, endSeq: 3, parentFrameId: null, returnValue: retval('None') })
    expect(index.frameSpans.get(2)).toMatchObject({ startSeq: 1, endSeq: 2, parentFrameId: 1, callLine: 10, returnValue: retval('1') })
  })

  it('leaves returnValue null for a frame that never emits a return event (e.g. it raised)', () => {
    resetSeq()
    const events = [ev({ event: 'call', frame_id: 1, func: 'main' })]
    const index = buildTraceIndex(events)
    expect(index.frameSpans.get(1)).toMatchObject({ returnValue: null })
  })

  it('groups repeated invocations of the same call site under one callSites entry, in order', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'run' }),
      ev({ event: 'call', frame_id: 2, func: 'noop', parent_frame_id: 1, call_line: 5 }),
      ev({ event: 'return', frame_id: 2, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '0' }),
      ev({ event: 'call', frame_id: 3, func: 'noop', parent_frame_id: 1, call_line: 5 }),
      ev({ event: 'return', frame_id: 3, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '1' }),
      ev({ event: 'return', frame_id: 1, func: 'run', return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    expect(index.callSites.get('1:5')).toEqual([2, 3])
  })

  it('preserves every distinct value of a variable across a loop instead of overwriting it', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'loop_example' }),
      ev({ event: 'line', frame_id: 1, func: 'loop_example', locals: { item: local('1', null, 'body') } }),
      ev({ event: 'line', frame_id: 1, func: 'loop_example', locals: { item: local('2', null, 'body') } }),
      ev({ event: 'line', frame_id: 1, func: 'loop_example', locals: { item: local('3', null, 'body') } }),
      ev({ event: 'return', frame_id: 1, func: 'loop_example', return_value: '[1, 2, 3]' }),
    ]
    const index = buildTraceIndex(events)
    const reprs = index.history.get(frameVarKey(1, 'item'))!.map((e) => e.value.repr)
    expect(reprs).toEqual(['1', '2', '3'])
  })

  it('records every pass over a repeated loop-body line, not just the last', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'sum_all' }), // seq 0, line 1 (default)
      ev({ event: 'line', frame_id: 1, func: 'sum_all', line: 4, locals: { total: local('0', null, 'body') } }), // seq 1
      ev({ event: 'line', frame_id: 1, func: 'sum_all', line: 4, locals: { total: local('1', null, 'body') } }), // seq 2
      ev({ event: 'line', frame_id: 1, func: 'sum_all', line: 4, locals: { total: local('3', null, 'body') } }), // seq 3
      ev({ event: 'return', frame_id: 1, func: 'sum_all', return_value: '3' }), // seq 4
    ]
    const index = buildTraceIndex(events)
    // Three passes over line 4 — each finished by the seq of the next event, in order —
    // instead of the last one silently overwriting the ones before it.
    expect(index.lineExitSeq.get(frameLineKey(1, 4))).toEqual([2, 3, 4])
  })
})

describe('buildTraceIndex — alias changes (identity)', () => {
  it('binds an object id to (frame,var) the first time it is captured', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'f', locals: { a: local('[1, 2]', 100, 'param') } }),
      ev({ event: 'return', frame_id: 1, func: 'f', locals: {}, return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    const changes = index.aliasChanges.get(100)!
    expect(changes[0]).toMatchObject({ key: frameVarKey(1, 'a'), bound: true })
  })

  it('rebinding to a new object immediately unbinds the old id, before any return', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'f' }),
      ev({ event: 'line', frame_id: 1, func: 'f', locals: { a: local('[1, 2]', 100, 'body') } }),
      ev({ event: 'line', frame_id: 1, func: 'f', locals: { a: local("{'x': 1}", 200, 'body') } }),
      ev({ event: 'return', frame_id: 1, func: 'f', return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    const changesFor100 = index.aliasChanges.get(100)!
    const changesFor200 = index.aliasChanges.get(200)!
    expect(changesFor100).toEqual([
      { seq: 1, key: '1:a', bound: true },
      { seq: 2, key: '1:a', bound: false },
    ])
    expect(changesFor200).toEqual([
      { seq: 2, key: '1:a', bound: true },
      { seq: 3, key: '1:a', bound: false }, // frame1 returns at seq 3, unbinding whatever `a` currently points to
    ])
  })

  it('a mutation (same id, changed repr) produces no alias change at all', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'f', locals: { a: local('[1, 2]', 100, 'param') } }),
      ev({ event: 'line', frame_id: 1, func: 'f', locals: { a: local('[1, 2, 3]', 100, 'param') } }),
      ev({ event: 'return', frame_id: 1, func: 'f', return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    // Only the return-triggered unbind should appear — no extra churn from the mutation line.
    expect(index.aliasChanges.get(100)).toEqual([
      { seq: 0, key: '1:a', bound: true },
      { seq: 2, key: '1:a', bound: false },
    ])
  })

  it('function return unbinds every name that frame ever bound, even if unchanged in the return event', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'f', locals: { a: local('[1, 2]', 100, 'param') } }),
      ev({ event: 'return', frame_id: 1, func: 'f', locals: {}, return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    expect(index.aliasChanges.get(100)).toEqual([
      { seq: 0, key: '1:a', bound: true },
      { seq: 1, key: '1:a', bound: false },
    ])
  })
})
