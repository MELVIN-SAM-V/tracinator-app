from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="relies on /proc")

REPO_ROOT = Path(__file__).resolve().parent.parent
FAKE_TOKEN = "fake-session-token-for-test"

# Runs the demo app in its own process so FAKE_TOKEN is in that process's real
# initial environment — /proc/<pid>/environ doesn't reflect later os.environ edits.
_SERVER = textwrap.dedent("""
    import json, sys
    from fastapi.testclient import TestClient
    from tracinator.server.demo_app import app

    payload = json.loads(sys.stdin.read())
    print(json.dumps(TestClient(app).post("/api/trace-from-source", json=payload).json()))
""")


def _trace(source: str, function: str, tmp_path: Path) -> tuple[dict, str]:
    env = {**os.environ, "TMPDIR": str(tmp_path), "AWS_SESSION_TOKEN": FAKE_TOKEN}
    proc = subprocess.run(
        [sys.executable, "-c", _SERVER],
        input=json.dumps({"source": source, "function": function, "args": [], "constructor_args": []}),
        capture_output=True,
        text=True,
        env=env,
        cwd=REPO_ROOT,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout), proc.stdout


def test_files_left_in_shared_tmp_do_not_run_in_later_requests(tmp_path):
    marker = tmp_path / "pwned.txt"
    (tmp_path / "json.py").write_text(f"open({str(marker)!r}, 'a').write('ran')\n")

    result, _ = _trace("def f():\n    return 1\n", "f", tmp_path)

    planted_code_ran = marker.exists()
    assert not planted_code_ran
    assert result["error"] is None
    assert result["events"]


# The snippets return only the credential entries: the tracer truncates long
# values, so returning a whole environment could hide a leak from the assertion.
def test_snippet_cannot_read_parent_process_environment(tmp_path):
    source = textwrap.dedent("""
        def steal():
            ppid = [l for l in open('/proc/self/status') if l.startswith('PPid')][0].split()[1]
            env = open('/proc/' + ppid + '/environ').read()
            return [e for e in env.split(chr(0)) if e.startswith('AWS_')]
    """)

    _, raw = _trace(source, "steal", tmp_path)

    leaked = FAKE_TOKEN in raw
    assert not leaked
    assert "PermissionError" in raw


def test_snippet_cannot_read_its_own_cloud_credentials(tmp_path):
    source = textwrap.dedent("""
        import sys

        def steal():
            own = open('/proc/self/environ').read().split(chr(0))
            via_os = [str(v) for k, v in sys.modules['os'].environ.items() if k.startswith('AWS_')]
            return [e for e in own if e.startswith('AWS_')] + via_os
    """)

    result, raw = _trace(source, "steal", tmp_path)

    leaked = FAKE_TOKEN in raw
    assert not leaked
    assert result["error"] is None
