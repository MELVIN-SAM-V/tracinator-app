from __future__ import annotations

from fastapi.testclient import TestClient

from tracinator.server.app import app, set_server_ref

client = TestClient(app)


def test_health_returns_ok():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_shutdown_is_inert_without_a_server_ref():
    set_server_ref(None)
    resp = client.post("/api/shutdown")
    assert resp.status_code == 200


def test_shutdown_flips_should_exit_on_the_registered_server():
    class FakeServer:
        should_exit = False

    server = FakeServer()
    set_server_ref(server)
    try:
        resp = client.post("/api/shutdown")
        assert resp.status_code == 200
        assert server.should_exit is True
    finally:
        set_server_ref(None)
