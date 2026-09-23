# RCA-002 — Tracing any class method always crashed

| | |
|---|---|
| **Date** | 2026-07-31 |
| **Severity** | High (an entire class of Python code could not be traced) |
| **Category** | Functional defect / unsupported case treated as supported |
| **Status** | Resolved |
| **Original doc** | `docs/phase3.4-class-method-support.md` |

## Summary

The tracer looked up its target with `getattr(module, function_name)`. Methods live on classes, not on the module, so tracing any method failed with `AttributeError`, whether the name was bare or dotted.

## Impact

- Any method of any class was untraceable.
- The same underlying gap left related behaviour broken: `self.other_method()`, `cls.x()` and `instance.method()` calls never resolved into navigable call nodes, and `self`/`cls` were shown as ordinary parameters in the graph and in the trace-arguments form.

## Detection

Class support had only ever worked by accident: `ast.walk()` descends into `class` bodies, so a method's bare name could sometimes be found and graphed. The defect was identified while specifying proper class support, not reported by a user.

## Root cause

The tracer assumed every traceable target is a module-level function. Nothing modelled classes: there was no notion of a method's kind (instance, class, static) or of how to construct an instance to call it on.

## Resolution

- Function names became qualified (`Foo.bar`, `Outer.Inner.method`). The tracer walks attribute access from the module to the class and inspects the *runtime* binding kind with `inspect.getattr_static`.
- Instance methods are called on an instance the tracer constructs, using constructor arguments supplied through the UI. Class and static methods are called directly. `__init__` is handled specially so the constructor runs exactly once, under tracing.
- Constructor instantiation happens inside the traced region, so a missing required constructor argument surfaces through the trace's normal `error` field instead of crashing the request.
- Call resolution learned `self.` / `cls.` calls, inheritance through real C3 method-resolution order, and instance tracking across modules.

## Regression tests

- `tests/test_event_tracer.py` — instance method traced with constructor arguments; entry frame points at the method, not the constructor.
- `tests/test_api_trace.py` — `constructor_args` accepted and defaulted on the trace request.
- `tests/test_call_resolver.py`, `tests/test_cfg_builder.py`, `tests/test_class_registry.py` — `self`/`cls` resolution, `self`/`cls` stripping from labels, method-kind detection.

## Boundary (documented, not hidden)

Third-party classes (numpy, pandas, and similar) are not resolved to source and remain a single external call node. Instance tracking is flow-insensitive ("last simple assignment wins").

## Lessons

- Behaviour that works "by accident" is unsupported behaviour; write down the supported surface and test its edges.
- Prefer failures that reach the user's UI over ones that crash the request.
