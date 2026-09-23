# RCA-001 — Static value propagation showed wrong, misleading variable values

| | |
|---|---|
| **Date** | 2026-07-22 |
| **Severity** | High (correctness — the tool's core promise is showing what the code really did) |
| **Category** | Correctness / design flaw |
| **Status** | Resolved — replaced by runtime tracing |
| **Original doc** | `docs/phase3.2.md`, `docs/phase3.1-patches.md` |

## Summary

Phase 3 computed the value of each variable by *simulating* Python: it walked the control-flow graph in order, substituted known values into expressions, and evaluated simple arithmetic in JavaScript. Any expression the simulation could not fully evaluate was shown as text instead of a value, and some evaluable expressions produced wrong output.

## Impact

Users were shown values that looked authoritative but were wrong or were not values at all:

- String operations rendered as unevaluated expressions. `a = a + b` with `a = "hello "` and `b = "world"` displayed `(('hello ')) + ('world')` instead of `'hello world'`.
- Method calls and builtins (`s.upper()`, `len(x)`) could not be evaluated statically at all.
- A gap in the simulation failed *silently*: an expression was displayed where a value should be, which could lead a user to read the expression as the value.
- A related patch (R2, Phase 3.1) fixed one visible symptom: navigating into `absolute_value(qwe)` where `qwe = 435` in the caller showed `n = (qwe)` instead of `n = 435`, because call arguments were stored as raw expression text and never evaluated against the caller's state.

## Detection

Found after Phase 3 shipped, through use, and tracked as post-release patches.

## Root cause

Static substitution is a re-implementation of Python semantics. Python has more behaviour than any hand-written evaluator covers, so every uncovered case produces wrong output, and the failure mode (showing an expression instead of an error or "unknown") hides the gap from the user. Patching individual cases, as R2 did, cannot close the class of problem.

## Resolution

Run the real function and record real values:

1. The backend runs the target function in a subprocess with a 5-second timeout and `sys.settrace` installed.
2. At every `line` and `return` event the tracer captures the frame's locals, using Python's own `repr()` of the actual objects.
3. The frontend maps each graph node's line range to the matching trace entry.

This was later extended into the whole-call-tree event-log tracer used today. Static propagation was kept for a time only as a fallback when a function could not be traced.

## Trade-offs accepted

- Tracing executes real code, so side effects (file writes, network calls) really happen. This is acceptable for a local developer tool. It is the reason the public demo runs in a sandbox (see RCA-005 and RCA-006).
- Functions that need external state (databases, network) may fail to trace.

## Lessons

- Do not simulate a language's semantics to display runtime values; observe an actual execution.
- When a value is unknown, say so. Never render an unevaluated expression in the place a value belongs.
