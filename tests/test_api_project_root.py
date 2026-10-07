from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tracinator.server import app as app_module
from tracinator.server.app import app, set_launch_config

# 127.0.0.1, not TestClient's default "testserver": app.py only accepts
# local Host headers (TrustedHostMiddleware, the DNS-rebinding guard).
client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def restore_root():
    original = app_module._project_root
    yield
    set_launch_config(root=original)


def test_switches_root_and_confines_browsing_to_it(tmp_path: Path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "main.py").write_text("def f():\n    return 1\n")

    resp = client.post("/api/project-root", json={"path": str(tmp_path)})
    assert resp.status_code == 200
    assert resp.json()["root"] == str(tmp_path.resolve())

    assert client.get("/api/config").json()["root"] == str(tmp_path.resolve())

    listing = client.get("/api/browse").json()
    assert listing["dirs"] == ["pkg"]
    assert listing["files"] == ["main.py"]

    outside = client.get("/api/browse", params={"path": str(tmp_path.parent)})
    assert outside.status_code == 400


def test_missing_folder_is_rejected_and_root_unchanged(tmp_path: Path):
    before = app_module._project_root
    resp = client.post("/api/project-root", json={"path": str(tmp_path / "nope")})
    assert resp.status_code == 404
    assert app_module._project_root == before


def test_a_file_is_not_accepted_as_a_root(tmp_path: Path):
    f = tmp_path / "main.py"
    f.write_text("")
    resp = client.post("/api/project-root", json={"path": str(f)})
    assert resp.status_code == 404


def test_non_json_body_is_rejected(tmp_path: Path):
    # A web page can send a text/plain POST cross-origin without a CORS
    # preflight; the root must only change through a real JSON request.
    before = app_module._project_root
    resp = client.post(
        "/api/project-root",
        content=f'{{"path": "{tmp_path}"}}',
        headers={"Content-Type": "text/plain"},
    )
    assert resp.status_code == 422
    assert app_module._project_root == before
