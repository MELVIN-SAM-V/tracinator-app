from __future__ import annotations

import textwrap
from pathlib import Path

from fastapi.testclient import TestClient

from tracinator.server.app import app

client = TestClient(app)

FUNCTIONS_FILE = str(Path(__file__).parent.parent / "testing" / "01_basic_flow" / "functions.py")
PROJECT_ROOT = str(Path(__file__).parent.parent / "testing" / "01_basic_flow")


def test_happy_path_returns_a_graph():
    resp = client.get("/api/graph", params={
        "file": FUNCTIONS_FILE, "function": "process_payment", "root": PROJECT_ROOT, "depth": 2,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert "process_payment" in body["entry_function"]


# ─── Recursion must not crash the server (regression) ─────────────────────────
#
# node.sub_graph used to embed a full, deeply-nested copy of the callee's cfg. A
# recursive function's own CALL node points back at the exact cfg it's part of,
# which made that a literal object cycle — serializing it (json.dumps via
# JSONResponse) raised RecursionError, surfaced to the client as a 500.

class TestRecursionDoesNotCrashTheApi:
    def test_direct_recursion(self, tmp_path):
        src = tmp_path / "fib.py"
        src.write_text(textwrap.dedent("""
            def fibonacci_nth(n):
                if n < 2:
                    return n
                return fibonacci_nth(n - 1) + fibonacci_nth(n - 2)
        """))
        resp = client.get("/api/graph", params={
            "file": str(src), "function": "fibonacci_nth", "root": str(tmp_path), "depth": 3,
        })
        assert resp.status_code == 200
        body = resp.json()
        cfg = body["all_graphs"]["fib.fibonacci_nth"]
        calls = [n for n in cfg["nodes"] if n["node_type"] == "CALL"]
        assert [c["label"] for c in calls] == ["→ fibonacci_nth(n - 1)", "→ fibonacci_nth(n - 2)"]
        # Still navigable — sub_graph is a lightweight ref, not the full nested cfg.
        assert all(c["sub_graph"] == {
            "function_name": "fibonacci_nth",
            "qualified_name": "fib.fibonacci_nth",
            "source_file": str(src),
        } for c in calls)

    def test_mutual_recursion(self, tmp_path):
        src = tmp_path / "mutual.py"
        src.write_text(textwrap.dedent("""
            def is_even(n):
                if n == 0:
                    return True
                return is_odd(n - 1)

            def is_odd(n):
                if n == 0:
                    return False
                return is_even(n - 1)
        """))
        resp = client.get("/api/graph", params={
            "file": str(src), "function": "is_even", "root": str(tmp_path), "depth": 3,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert set(body["all_graphs"].keys()) == {"mutual.is_even", "mutual.is_odd"}
