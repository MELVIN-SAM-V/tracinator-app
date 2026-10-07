"""The local backend's guards against other web pages driving it: the Host
check (DNS rebinding), the per-launch API token, and the Editor tab's traces
running under tracinator's own interpreter."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tracinator.server import app as app_module
from tracinator.server.app import API_TOKEN_HEADER, app, set_api_token

client = TestClient(app, base_url="http://127.0.0.1")
TOKEN = "test-token-123"


@pytest.fixture(autouse=True)
def restore_globals():
    token = app_module._api_token
    override = app_module._python_executable_override
    yield
    set_api_token(token)
    app_module.set_python_executable_override(override)


# --- Host check -------------------------------------------------------------

@pytest.mark.parametrize("host", ["evil.example", "evil.example:7331", "192.168.1.5:7331"])
def test_rejects_foreign_host_header(host):
    # What a DNS-rebound request looks like: it reaches 127.0.0.1, but the
    # browser still names the attacker's domain in Host.
    resp = client.get("/api/health", headers={"Host": host})
    assert resp.status_code == 400


@pytest.mark.parametrize("host", ["127.0.0.1:7331", "localhost:7331", "localhost"])
def test_accepts_local_host_header(host):
    assert client.get("/api/health", headers={"Host": host}).status_code == 200


# --- API token --------------------------------------------------------------

def test_api_requires_token_when_configured():
    set_api_token(TOKEN)
    assert client.get("/api/config").status_code == 401
    assert client.get("/api/config", headers={API_TOKEN_HEADER: "wrong"}).status_code == 401
    assert client.get("/api/config", headers={API_TOKEN_HEADER: TOKEN}).status_code == 200


def test_shutdown_requires_token():
    # The one route a plain cross-site form/fetch could reach with no
    # rebinding at all, since it takes no body.
    set_api_token(TOKEN)
    assert client.post("/api/shutdown").status_code == 401


def test_health_and_non_api_paths_need_no_token():
    set_api_token(TOKEN)
    assert client.get("/api/health").status_code == 200
    # Stands in for index.html/assets, which only exist after a UI build:
    # anything outside /api/ must load before the frontend has the token.
    assert client.get("/docs").status_code == 200


def test_cors_preflight_is_not_blocked_by_token():
    set_api_token(TOKEN)
    resp = client.options(
        "/api/config",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": API_TOKEN_HEADER,
        },
    )
    assert resp.status_code == 200


def test_no_token_configured_means_check_is_off():
    set_api_token(None)
    assert client.get("/api/config").status_code == 200


def test_token_is_read_from_env_and_removed_from_it():
    # Fresh interpreter: the token is read when app.py is imported.
    code = (
        "import os\n"
        "os.environ['TRACINATOR_API_TOKEN'] = 'from-env'\n"
        "from tracinator.server import app as a\n"
        "print(a._api_token, 'TRACINATOR_API_TOKEN' in os.environ)\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, check=True,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent.parent)},
    ).stdout.split()
    assert out == ["from-env", "False"]


# --- Editor tab interpreter -------------------------------------------------

def _capture_trace_interpreter(monkeypatch) -> list:
    seen = []

    def fake_trace_call_tree(file_path, function, args, constructor_args, python_executable=None):
        seen.append(python_executable)
        return {"events": [], "return_value": None, "error": None, "truncated": False}

    monkeypatch.setattr(app_module, "trace_call_tree", fake_trace_call_tree)
    return seen


def test_editor_code_traces_with_tracinators_interpreter(monkeypatch):
    seen = _capture_trace_interpreter(monkeypatch)
    app_module.set_python_executable_override("/some/project/python")

    graph = client.post("/api/graph-from-source", json={"source": "def f(x):\n    return x\n", "function": "f"})
    assert graph.status_code == 200
    resp = client.post("/api/trace", json={"file": graph.json()["entry_file"], "function": "f", "args": ["1"]})

    assert resp.status_code == 200
    assert seen == [None]  # None -> trace_call_tree uses sys.executable


def test_project_files_still_trace_with_project_interpreter(monkeypatch, tmp_path: Path):
    seen = _capture_trace_interpreter(monkeypatch)
    app_module.set_python_executable_override("/some/project/python")
    project_file = tmp_path / "main.py"
    project_file.write_text("def f(x):\n    return x\n")

    resp = client.post("/api/trace", json={"file": str(project_file), "function": "f", "args": ["1"]})

    assert resp.status_code == 200
    assert seen == ["/some/project/python"]
