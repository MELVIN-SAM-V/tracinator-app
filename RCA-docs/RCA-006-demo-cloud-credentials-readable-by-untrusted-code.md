# RCA-006 — Demo: untrusted snippets could read the server's cloud credentials

| | |
|---|---|
| **Date** | 2026-09-20 |
| **Severity** | Medium (confirmed locally; limited by the role's permissions) |
| **Category** | Sensitive data exposure / sandbox weakness |
| **Status** | Resolved |
| **Component** | `tracinator/server/demo_app.py`, `tracinator/tracer/event_tracer.py`, `tracinator/server/sandbox_guard.py` |

## Summary

Code submitted to the public demo runs in a child process of the API server. Two independent paths let that code read the server's environment, which on AWS Lambda contains the function's temporary credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`). The trace response returns values from the snippet to the visitor, so anything the snippet read could be sent straight back.

## Impact

Any visitor could obtain the demo Lambda's temporary role credentials.

The role is minimal: the AWS-managed CloudWatch Logs and VPC-networking policies. The credentials cannot read application data, because there is none. The realistic abuse is writing log data into the account (a cost risk, which the account's spend alerts cover) and enumerating or altering network interfaces. This is defense-in-depth failing, not data theft. Reading the parent's environment through `/proc` was confirmed on the local Linux test host; that the same read succeeds inside Lambda's sandbox was not tested.

## Detection

Found in a security review. Reproduced locally with a fake credential placed in the server process's real initial environment, then confirmed to appear in the trace response.

## Root cause

Three properties combined:

1. **The child inherited everything.** The tracer built the child's environment from a full copy of the server's, so the credentials were present in the child's own environment.
2. **The parent's environment was readable.** A child running as the same OS user can read its parent's `/proc/<pid>/environ`, so scrubbing the child's own environment alone would not have closed the gap.
3. **The filter did not cover these routes.** The import blocklist stops `os` and similar imports, but not the built-in `open()` and not modules reachable through `sys.modules`.

Separately, the comment in `sandbox_guard.py` claimed the demo role had "no IAM permissions", which was inaccurate: it has the two managed policies above. That understated the real blast radius.

## Resolution

- The demo server marks its own process non-dumpable (`PR_SET_DUMPABLE = 0`) at startup, so a same-user child can no longer read the server's `/proc` files. This is best-effort and a no-op where `prctl` doesn't exist.
- The tracer gained an opt-in `scrub_cloud_credentials` option that drops every `AWS_*` variable from the child's environment. The demo turns it on; the desktop app does not, because a user's own project may legitimately need its own environment.
- The `sandbox_guard.py` comment was corrected to describe the actual role and the per-request working directories added in RCA-005.

## Verification

`tests/test_demo_sandbox_isolation.py`:

- `test_snippet_cannot_read_parent_process_environment`
- `test_snippet_cannot_read_its_own_cloud_credentials`

Both run the demo in a fresh process holding a fake credential and assert it never reaches the response. The snippets return only the credential lines, because the tracer truncates long values and a whole-environment dump could hide a leak. Every test in the file fails on the pre-fix code and passes after the fix. The tests skip on non-Linux systems because they rely on `/proc`.

## Follow-ups

- Scope the function's CloudWatch Logs permission to its own log group instead of the broad managed policy.
- Consider stronger isolation for untrusted code (a separate execution environment or user) rather than relying on filtering.

## Lessons

- Environment variables are readable by everything running as the same user, including the parent process.
- A denylist filter is convenience only. Assume untrusted code can reach anything the process can.
- Keep security comments accurate: an overstated boundary hides real risk.
