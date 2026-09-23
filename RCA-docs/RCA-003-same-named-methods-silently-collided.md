# RCA-003 — Same-named methods on different classes silently collided

| | |
|---|---|
| **Date** | 2026-07-31 |
| **Severity** | High (silent wrong result — no error was raised) |
| **Category** | Correctness / identity |
| **Status** | Resolved |
| **Original doc** | `docs/phase3.4-class-method-support.md` |

## Summary

Functions were identified by their bare AST name everywhere in the system. When two classes defined a method with the same name, one silently replaced the other and the tool graphed or traced the wrong function.

## Impact

For any project where two classes share a method name (`speak`, `save`, `__init__`, `run`, …), the function picker, the graph, call navigation, the trace request and the CLI could each resolve to the wrong method, with no warning. Whichever definition `ast.walk` visited last won, project-wide.

## Detection

Found while investigating class support (see RCA-002).

## Root cause

Every function-discovery path was a flat dictionary or list keyed by the bare `FunctionDef.name`:

- `parser.find_function`
- `context_builder`'s `module_functions` / `local_funcs`
- `call_resolver.find_function_in_file`
- `/api/functions` and `/api/functions-from-source`

Two further places compounded it: `ControlFlowGraph.function_name` (used by the frontend to re-navigate into a sub-graph) was set from the bare name, and the CLI's `_get_entry_cfg` matched on that same bare name.

The underlying design error was using a non-unique display name as an identifier.

## Resolution

- A class registry assigns every function a dotted, class-relative qualified name (`Cat.speak`, `Dog.speak`). `qualified_name` is the canonical identifier across the API, picker, graph and trace request, so the fix holds end to end and not only server-side.
- `ControlFlowGraph.function_name` became the exact string that can be passed back to `/api/graph?function=`.
- `ProjectContext` gained `entry_qualified_name`; the CLI looks up `ctx.all_graphs[ctx.entry_qualified_name]` instead of comparing bare names.
- Lookup policy: an exact dotted match wins; a bare name is accepted only if it matches exactly one function; if it matches several, lookup raises an error listing the ambiguous qualified names and asking for the `Class.method` form.

## Regression tests

- `tests/test_class_registry.py` — same-named methods on two classes do not collide; a bare ambiguous name raises.
- `tests/test_cfg_builder.py` — the graph's function name is dotted.

## Lessons

- Never use a display name as an identifier. Give entities a unique canonical ID and carry it through every layer.
- When a lookup can be ambiguous, fail loudly and list the candidates; do not pick one.
