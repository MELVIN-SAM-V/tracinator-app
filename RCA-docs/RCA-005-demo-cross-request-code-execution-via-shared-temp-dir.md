# RCA-005 — Demo: one visitor's leftover files could run inside another visitor's request

| | |
|---|---|
| **Date** | 2026-09-20 |
| **Severity** | Medium (confirmed locally; the cloud impact follows from documented Lambda `/tmp` reuse and was not tested on the live service) |
| **Category** | Isolation failure / cross-tenant contamination |
| **Status** | Resolved |
| **Component** | `tracinator/server/demo_app.py`, `tracinator/tracer/event_tracer.py` |

## Summary

The public demo wrote each visitor's snippet, and the generated harness script that runs it, into the default temporary directory. When a script runs, Python places the script's directory first on its module search path, and the tracer also inserts the traced file's directory there. On AWS Lambda a warm container reuses `/tmp` between requests, so files written by one request were still present, and importable, in later requests.

## Impact

A visitor's code can write files into the shared temp directory, for example one named like a standard-library module. A later request handled by the same warm container would import that file instead of the real module, and run the earlier visitor's code inside the later visitor's request. That code could observe or alter the later visitor's source and results. This contradicts the documented promise that pasted code is "never saved, never shared with other visitors."

The demo's import filter did not prevent this. It blocks imports of a fixed list of modules and a few calls (`eval`, `exec`, `compile`, `__import__`), but plain file writes with `open()` are allowed.

## Detection

Found in a security review of the repository. Reproduced locally by placing a file in a scratch temp directory and confirming that a later, unrelated request executed it. Because the trace runs in a child process spawned per request, the effect on Lambda depends on warm-container reuse; that part is inferred from Lambda's documented behaviour and was not tested against the live service.

## Root cause

Untrusted and shared state lived in one directory that was also a code-loading location. Three properties combined:

1. Per-request files and the harness script were created in a directory shared across requests.
2. That directory was on the module search path of the process executing untrusted code.
3. Nothing cleaned the directory of files the untrusted code itself had created.

The comment in `sandbox_guard.py` correctly says the import filter "is not the security boundary". The real boundary is infrastructure isolation, and this issue was a hole in it.

## Resolution

- Every request now gets its own freshly created, empty directory, removed when the request ends. The snippet and the generated harness script both live there, so the search path contains only that directory, and files left in the shared temp directory are never importable.
- `trace_call_tree` gained an optional `work_dir` argument for the harness script's location. The default is unchanged, so the desktop app's behaviour is untouched.
- The graph-from-source endpoint uses the same per-request directory as its project root, so it no longer scans the shared temp directory either.

## Verification

`tests/test_demo_sandbox_isolation.py::test_files_left_in_shared_tmp_do_not_run_in_later_requests` runs the demo in a fresh process with a planted file in the temp directory and asserts that it never executes and that the trace still completes normally. The test fails against the pre-fix code and passes after the fix.

## Follow-ups

- Treat the import filter as a convenience only. Do not extend it as though it were a boundary.

## Lessons

- Never let a directory that untrusted code can write to double as a code-loading location.
- Assume warm serverless containers keep state between requests, and give each request its own workspace.
