from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from tracinator.server.app import app

client = TestClient(app)

FUNCTIONS_FILE = str(Path(__file__).parent.parent / "testing" / "01_basic_flow" / "functions.py")
BUGGY_FILE = str(Path(__file__).parent.parent / "testing" / "03_error_case" / "buggy.py")
CLASSES_FILE = str(Path(__file__).parent.parent / "testing" / "05_classes" / "models.py")


def test_happy_path_returns_events_and_return_value():
    resp = client.post("/api/trace", json={"file": FUNCTIONS_FILE, "function": "process_payment", "args": ["500.0", "'u1'"]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] is None
    assert body["return_value"]["repr"] == "True"
    funcs = [e["func"] for e in body["events"] if e["event"] == "call"]
    assert funcs == ["process_payment", "get_user", "charge"]


def test_missing_file_returns_404():
    resp = client.post("/api/trace", json={"file": "/no/such/file.py", "function": "f", "args": []})
    assert resp.status_code == 404


def test_target_function_raising_returns_200_with_error_field():
    resp = client.post("/api/trace", json={"file": BUGGY_FILE, "function": "grade_score", "args": ["50"]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] is not None
    assert "grade" in body["error"]


def test_trace_request_defaults_constructor_args_to_empty_list():
    resp = client.post("/api/trace", json={"file": FUNCTIONS_FILE, "function": "process_payment", "args": ["500.0", "'u1'"]})
    assert resp.status_code == 200
    assert resp.json()["error"] is None


def test_instance_method_trace_with_constructor_args():
    resp = client.post("/api/trace", json={
        "file": CLASSES_FILE,
        "function": "Base.base_method",
        "args": [],
        "constructor_args": ["5"],
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] is None
    assert body["return_value"]["repr"] == "10"
