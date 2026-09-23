#!/usr/bin/env bash
# Runs the real (non-demo) backend and frontend together for local testing,
# with one command. Convenience only — same reasoning as dev_demo.sh:
# production splits these into separate services (CloudFront/S3 for the
# frontend, API Gateway/Lambda for the API — see infra/modules/frontend and
# infra/modules/api), this just launches both halves locally and stops them
# together on exit.
#
# Unlike dev_demo.sh, this points the frontend at tracinator/server/app.py
# (the real backend with filesystem browsing — see /api/browse — not the
# sandboxed paste-code-and-run demo). Don't mix them: app.py has no
# /api/trace-from-source route, and demo_app.py has no /api/browse route.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_PORT="${1:-7331}"

BACKEND_PID=""
cleanup() {
  if [ -n "$BACKEND_PID" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# app.py's file browser defaults to its own cwd at import time (see
# _project_root in tracinator/server/app.py) — cd here first so it defaults
# to browsing the whole repo instead of wherever this script happened to be
# invoked from.
cd "$REPO_ROOT"
"$REPO_ROOT/.venv/bin/uvicorn" tracinator.server.app:app --reload --port "$BACKEND_PORT" &
BACKEND_PID=$!

until curl -sf "http://localhost:$BACKEND_PORT/docs" >/dev/null 2>&1; do
  sleep 0.5
done
echo "Backend up on :$BACKEND_PORT"

cd "$REPO_ROOT/tracinator/ui"
npm run dev
