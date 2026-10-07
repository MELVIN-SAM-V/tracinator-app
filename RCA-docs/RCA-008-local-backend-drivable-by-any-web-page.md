# RCA-008 — Local backend could be driven by any web page via DNS rebinding

| | |
|---|---|
| **Date** | 2026-10-07 |
| **Severity** | High (arbitrary code execution and file reads on the user's machine; needs Tracinator running and the user to visit an attacker's page) |
| **Category** | Security / missing request-origin validation (DNS rebinding) |
| **Caught** | After release: 0.1.0 was public from 2026-10-06. No exploitation reported. |
| **Status** | Resolved in code (`main` at `f16f896`); ships in desktop 0.1.1 |
| **Component** | `tracinator/server/app.py`, `tracinator/cli.py`, `src-tauri/src/lib.rs`, `tracinator/ui/src/lib/api.ts`, `infra/scripts/dev_app.sh` |

## Summary

The local backend that the desktop app and `tracinator ui` run on `127.0.0.1` answered every request that reached it. It checked neither the `Host` header nor any credential. A web page open in the user's browser can reach that server through DNS rebinding and, because the browser then treats the page as same-origin with the backend, read the responses and send JSON requests. Two existing endpoints turn that into full compromise: `/api/source` returns any file on disk, and `/api/trace` runs its arguments as Python source.

## Impact

While Tracinator was running, a page the user visited could:

- **Read any file the user can read** through `GET /api/source?file=…`, which, unlike `/api/browse`, has no project-root check. For example `~/.ssh/id_rsa` or `~/.aws/credentials`.
- **Run arbitrary code as the user** through `POST /api/trace`. The tracer pastes each argument string into a generated Python script (`event_tracer.py`, `run_trace(..., [{args_source}], ...)`), so an argument such as `__import__('os').system(...)` executes before the traced function is even looked up. Any existing `.py` file satisfies the endpoint's only check, `path.exists()`, and every Python install has hundreds at predictable paths.
- **Point tracing at any executable** through `POST /api/python-executable`.
- **Shut the backend down** through `POST /api/shutdown`. This one needed no rebinding at all: a bodyless cross-site POST is a "simple" request the browser sends without a CORS preflight.

Exposure: desktop 0.1.0, published to `releases.tracinator.com` and linked from `tracinator.com/download` on 2026-10-06, and every `tracinator ui` session since the local UI existed. The number of 0.1.0 downloads is unknown, because CloudFront access logging isn't enabled. The attack needs the app running, a guessable port (the default is a fixed 7331), and the user keeping the attacker's page open while the DNS answer is switched, typically under a minute with existing rebinding tools.

## Detection

Raised by the developer as a security question the day after 0.1.0 was published, then confirmed by code review of each link in the chain: no `Host` check, no authentication, `/api/source` unrestricted, and trace arguments evaluated as source. The full rebinding attack was not run against a real rebinding DNS service. The individual pieces were confirmed directly.

## Root cause

The backend treated "reachable" as "trusted". Binding to `127.0.0.1` keeps other machines out, but the user's own browser runs untrusted code from every site it visits, on the same machine. Three properties combined:

1. **No `Host` validation.** A rebound request still names the attacker's domain in `Host`. The server never looked at it.
2. **No credential.** Nothing distinguished Tracinator's own frontend from any other page.
3. **Powerful endpoints by design.** Evaluating user-typed arguments as Python is the trace form's purpose. That is safe only if the request really comes from the user.

CORS did not help: it restricts *cross*-origin reads, and rebinding makes the attacker's page same-origin.

## Resolution

- **`Host` allowlist.** `TrustedHostMiddleware` accepts only `127.0.0.1` and `localhost`, so a rebound request gets `400` before any route runs. This alone stops rebinding.
- **Per-launch API token.** Every `/api` route except `/api/health` requires `X-Tracinator-Token`, compared with `secrets.compare_digest`. CORS preflights pass through. The backend never serves the token, since a rebinding page could read anything it serves:
  - **Desktop:** the Rust shell generates 32 random bytes per launch (`getrandom`), passes them to Python as `TRACINATOR_API_TOKEN`, and injects them into the window with `initialization_script`. The script only sets the token on the backend's own origin, because Tauri runs it on every page the window loads. The shell also sends the token with its own `/api/shutdown`.
  - **`tracinator ui` and `dev_app.sh`:** the token goes in the `?token=` link that's opened or printed. The frontend moves it into `sessionStorage` and removes it from the address bar.
  - `app.py` pops the variable from its environment at import, so traced code, a child process, doesn't inherit it.
  - With no token configured (tests, a hand-started `uvicorn`), the token check is off and the `Host` check still applies.
- **Frontend.** All `/api` calls go through `apiFetch()`, which adds the header when a token is known. A rejected session shows a banner explaining how to reopen the app. The public demo sends no header, and its separate backend (`demo_app.py`) has no such check.

## Verification / regression tests

`tests/test_api_security.py`:

- `test_rejects_foreign_host_header`, `test_accepts_local_host_header`
- `test_api_requires_token_when_configured`, `test_shutdown_requires_token`
- `test_health_and_non_api_paths_need_no_token`, `test_cors_preflight_is_not_blocked_by_token`
- `test_no_token_configured_means_check_is_off`
- `test_token_is_read_from_env_and_removed_from_it`

`tracinator/ui/src/lib/api.test.ts` covers token capture from the URL, the injected desktop token, and the demo case with no header.

Against a real running backend on Linux, launched the way the desktop app launches it:

- no token or a wrong token → `401`; the right token → `200`;
- `Host: evil.example`, even with the right token → `400`;
- `/api/source` for `~/.bashrc` with no token → `401`;
- a tokenless `/api/shutdown` → `401`, and the backend stays up;
- a traced function reading `TRACINATOR_API_TOKEN` from its environment gets nothing.

On Windows, the installed build returned `200` for `/api/health`, `401` for tokenless and wrong-token API calls and for `/api/shutdown`, and `400` for a foreign `Host`, while the app itself kept working.

## Follow-ups

- Publish desktop 0.1.1 so installed 0.1.0 copies update, and bump the download page.
- If the `tracinator` Python package is published, release a new version so `tracinator ui` users get the fix.
- Optional extra layers: confine `/api/source` to the project root plus the backend's own Editor temp files, and pick a random port instead of a fixed 7331.
- Consider enabling CloudFront access logs on the releases host, so exposure windows like this one can be sized.

## Lessons

- `127.0.0.1` is not a trust boundary. The user's browser runs untrusted code on the same machine.
- A local server that can read files or run code needs both a `Host` check and a credential the browser can't obtain.
- Deliver secrets outside the server they protect. Anything the server serves, a rebinding page can read.
- Check the full request path before a public release. This was reachable in 0.1.0 because no review asked who else could talk to the backend.
