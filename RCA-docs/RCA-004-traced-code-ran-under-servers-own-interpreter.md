# RCA-004 — User code was executed by the server's own Python interpreter

| | |
|---|---|
| **Date** | 2026-08-15 |
| **Severity** | High (would have broken tracing of any real project in the desktop app) |
| **Category** | Design flaw / environment coupling |
| **Status** | Resolved |
| **Original doc** | `docs/deployment.md` |

## Summary

`trace_call_tree` ran the traced function with `subprocess.run([sys.executable, ...])`, reusing whatever interpreter was running Tracinator's own server to execute the user's own project code.

## Impact

Latent for developers, because in a development setup the server and the project often share a virtual environment. It would have failed immediately in the desktop app: the server runs on a private Python bundled with the installer, and that interpreter becomes `sys.executable`. Tracing a project that imports its own dependencies (numpy, Django, and so on) would try to import them from the bundled interpreter, which only contains Tracinator's server dependencies. Every real project with external dependencies would have failed to trace.

## Detection

Found during design of the desktop installer, before it shipped.

## Root cause

Two unrelated questions were answered by one value:

1. Which interpreter runs Tracinator's server?
2. Which interpreter executes the code being traced?

They coincided in development and diverge in production.

## Resolution

- `trace_call_tree` takes a `python_executable` parameter used for the traced subprocess; the default preserves the old behaviour for the CLI and dev scripts.
- The server resolves the traced-code interpreter in order: an explicit override, then a `.venv` or `venv` under the project root (matching the convention the file browser already assumed), then `python3` / `python` on `PATH`.
- The resolved interpreter is reported through `/api/config` and can be overridden through `/api/python-executable`.
- The public demo is unaffected: it only ever traces sandboxed single-file snippets.

## Regression test

`tests/test_event_tracer.py::test_explicit_python_executable_can_import_a_package_only_it_has` — traces a function that imports a package present only in a second interpreter, proving the separation works and not merely that nothing regressed.

## Design note

The tracer module is imported in the child process through `PYTHONPATH`, and is designed to need only the standard library, so any Python 3 interpreter can act as the traced-code interpreter without Tracinator's server dependencies installed.

## Lessons

- When two roles are played by one runtime value, ask whether they can ever diverge (development versus packaged, local versus cloud).
- Design for the packaged environment first; the developer environment hides this class of bug.
