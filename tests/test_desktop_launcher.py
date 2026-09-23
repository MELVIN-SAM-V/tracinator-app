from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from tracinator.desktop_launcher import _watch_parent


# ─── _watch_parent ────────────────────────────────────────────────────────────
# Regression: closing the desktop app doesn't always take its spawned Python
# backend down with it — the graceful path only fires on Tauri's own
# WindowEvent::CloseRequested, and a plain OS-level parent kill doesn't kill
# children either. Confirmed as a real leak: orphaned backends observed still
# running hours after their window was gone, reparented to init — the
# reparenting itself (os.getppid() changing) is what this watches for.

class TestWatchParent:
    def test_sets_should_exit_once_reparented(self):
        server = SimpleNamespace(should_exit=False)
        original_ppid = 111
        # First poll: still under the original parent (no change). Second
        # poll: reparented to init (ppid changed) — should stop right there.
        with patch("tracinator.desktop_launcher.os.getppid", side_effect=[original_ppid, 999]), \
             patch("tracinator.desktop_launcher.time.sleep"):
            _watch_parent(server, poll_interval=0)
        assert server.should_exit is True

    def test_never_reparented_keeps_polling(self):
        server = SimpleNamespace(should_exit=False)
        original_ppid = 111
        calls = {"n": 0}

        def fake_sleep(_interval):
            calls["n"] += 1
            if calls["n"] >= 5:
                # Simulate the server shutting down for some unrelated reason
                # (e.g. the graceful /api/shutdown path) so the loop can exit
                # on its own `while not server.should_exit` check instead of
                # spinning forever in the test.
                server.should_exit = True

        with patch("tracinator.desktop_launcher.os.getppid", return_value=original_ppid), \
             patch("tracinator.desktop_launcher.time.sleep", side_effect=fake_sleep):
            _watch_parent(server, poll_interval=0)
        # should_exit only flipped via the simulated external shutdown above,
        # never because _watch_parent itself detected a (nonexistent) reparent.
        assert calls["n"] == 5
