# RCA-007 — Release build blocked by an npm/Rust version mismatch in the updater plugin

| | |
|---|---|
| **Date** | 2026-09-24 |
| **Severity** | Medium (no release builds possible; running installs unaffected) |
| **Category** | Build / dependency management |
| **Status** | Resolved |
| **Component** | `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `tracinator/ui/package.json`, `tracinator/ui/package-lock.json` |

## Summary

`tauri build` refused to build because the updater plugin was locked at 2.12.0 on the npm side (`@tauri-apps/plugin-updater`) and 2.11.0 on the Rust side (`tauri-plugin-updater`).

## Impact

No installers could be produced until the fix landed. Users already running the app were unaffected: auto-updates are served from `https://releases.tracinator.com/latest.json`, not from the build machine.

## Detection

`tauri build` failed its plugin version check. Tauri requires each plugin's npm package and Rust crate to share the same major.minor version.

## Root cause

The npm and Rust halves of the same plugin are locked in separate files, and nothing kept them in step. Loose version ranges on both sides let one move without the other.

1. **npm moved.** `package.json` asked for `^2.11.0` (any 2.x from 2.11.0 up). When this repo was split out of `execution-graph-engine` on 2026-09-23 (`2ed5f31`), `package-lock.json` was rebuilt and npm picked the newest match, 2.12.0.
2. **Rust stayed.** `Cargo.toml` asked for `"2"`, which also allows 2.12.0. But Cargo only changes `Cargo.lock` on `cargo update`, and the lockfile was copied over unchanged at 2.11.0.
3. **The build caught it.** 2.12 vs 2.11 failed Tauri's major.minor check.

The split exposed the problem, but any routine `npm install` that picked up a new minor version could have caused the same drift.

## Resolution

- `4a63833` bumped `tauri-plugin-updater` in `Cargo.lock` to 2.12.0 to match npm.
- Both manifests were then pinned to the exact same version so they can't drift silently:

| File | Before | After |
|---|---|---|
| `src-tauri/Cargo.toml` | `"2"` | `"=2.12.0"` |
| `tracinator/ui/package.json` | `"^2.11.0"` | `"2.12.0"` |
| `tracinator/ui/package-lock.json` (root spec) | `"^2.11.0"` | `"2.12.0"` |

## Verification

- `npm ls @tauri-apps/plugin-updater` resolves to 2.12.0.
- `Cargo.lock` records `tauri-plugin-updater` 2.12.0, which satisfies `=2.12.0`. A full `tauri build` has not yet been re-run after pinning.

## Follow-ups

- Done: every package with a partner in the other ecosystem is now pinned to its locked version — `tauri` `=2.11.5` / `@tauri-apps/api` `2.11.1` / `@tauri-apps/cli` `2.11.5`, `tauri-plugin-store` `=2.4.4` / `@tauri-apps/plugin-store` `2.4.5`, and `tauri-plugin-process` `=2.3.1` / `@tauri-apps/plugin-process` `2.3.1`. Rust-only crates (`tauri-build`, `tauri-plugin-log`, `tauri-plugin-dialog`) and non-Tauri dependencies keep their ranges; the lockfiles already fix them, and pinning them would only block patch updates.
- Add a pre-build script or CI step that compares npm and Cargo plugin versions and fails fast on a major.minor mismatch.

## Lessons

- When one component ships as two packages in two ecosystems, pin them together and upgrade them in the same commit (`package.json` + `Cargo.toml`, then `npm install` and `cargo update -p <crate>`).
- Rebuilding one lockfile but not the other is a silent upgrade. When moving or splitting a repo, carry both lockfiles over unchanged, or regenerate both.
