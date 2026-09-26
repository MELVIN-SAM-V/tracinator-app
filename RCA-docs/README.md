# Root Cause Analyses

One document per significant defect, vulnerability or security change, with the root cause, the fix, and the lessons. Routine UI tweaks and feature work are not recorded here.

| ID | Title | Category | Severity | Status |
|---|---|---|---|---|
| [RCA-001](RCA-001-static-propagation-wrong-values.md) | Static value propagation showed wrong, misleading variable values | Correctness | High | Resolved |
| [RCA-002](RCA-002-method-tracing-always-crashed.md) | Tracing any class method always crashed | Functional | High | Resolved |
| [RCA-003](RCA-003-same-named-methods-silently-collided.md) | Same-named methods on different classes silently collided | Correctness | High | Resolved |
| [RCA-004](RCA-004-traced-code-ran-under-servers-own-interpreter.md) | User code was executed by the server's own Python interpreter | Design | High | Resolved |
| [RCA-005](RCA-005-demo-cross-request-code-execution-via-shared-temp-dir.md) | Demo: one visitor's leftover files could run inside another visitor's request | Security | Medium | Resolved |
| [RCA-006](RCA-006-demo-cloud-credentials-readable-by-untrusted-code.md) | Demo: untrusted snippets could read the server's cloud credentials | Security | Medium | Resolved |
| [RCA-007](RCA-007-updater-plugin-npm-rust-version-mismatch.md) | Release build blocked by an npm/Rust version mismatch in the updater plugin | Build | Medium | Resolved |

RCA-001 to RCA-004 were extracted from the project's earlier design and review docs. RCA-005 and RCA-006 come from the 2026-09-20 security sweep.

Two further RCAs, on a now-removed licensing feature (license-key disclosure via machine fingerprint, and forgeable local license state), were dropped from this index along with the feature itself rather than kept as historical entries.

## Considered and not included

- **Multi-line statements rendered on one line** (Phase 3.1, R1): a whitespace-collapsing display bug with no functional or security impact.
- **Incomplete gating of one read endpoint** on the (now-removed) licensing feature, and the **unscoped desktop-shell `opener` permission**: both were assessed as not vulnerabilities in the original review. The permission was removed on 2026-09-20.
- **Phase design docs** (`docs/phase*.md`, `docs/deployment.md`): specifications and plans, not incident write-ups, apart from the defects extracted above.
- **`localStorage` resetting when the desktop app's port changes**: raised as a design risk during planning and addressed by a small persistence abstraction. No defect had shipped.

## Template

```
# RCA-NNN — Title
| Date | Severity | Category | Status | Component/Original doc |
## Summary
## Impact
## Detection
## Root cause
## Resolution
## Verification / regression tests
## Follow-ups   (if any)
## Lessons
```
