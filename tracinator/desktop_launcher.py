"""Entry point spawned by the Tauri desktop shell (`src-tauri`), not by `tracinator ui`.

Unlike `cli.py`'s `_launch_ui` (developer-facing: runs uvicorn on a background
thread, opens the system browser, blocks on Ctrl+C), this runs uvicorn directly
on the main thread with no browser handling — the host process (Tauri) owns the
window and drives shutdown via `POST /api/shutdown`, which flips
`server.should_exit` through `set_server_ref` below.

That graceful path only covers the window actually being closed through Tauri's
own event (`WindowEvent::CloseRequested` in `src-tauri/src/lib.rs`) — it never
fires if the Rust parent is killed directly instead (Ctrl+C in a `tauri dev`
terminal, closing that terminal, a crash), and a plain OS-level parent death
doesn't take a `Command::spawn()`ed child down with it either. Confirmed as a
real, repeatable leak during development: this process kept running for hours
after its window was long gone, reparented to init. `_watch_parent` below is
the POSIX-appropriate safety net for exactly that: once the original parent is
gone, this process gets reparented (to init or the nearest subreaper), which
is the standard, dependency-free way for a child to notice its parent died —
poll `os.getppid()` for the change and shut down the same way `/api/shutdown`
already does.
"""
from __future__ import annotations
import argparse
import os
import threading
import time

import uvicorn

from tracinator.server.app import app, set_launch_config, set_server_ref

PARENT_POLL_INTERVAL = 2.0


def _watch_parent(server: uvicorn.Server, poll_interval: float = PARENT_POLL_INTERVAL) -> None:
    original_ppid = os.getppid()
    while not server.should_exit:
        time.sleep(poll_interval)
        if os.getppid() != original_ppid:
            server.should_exit = True
            return


def main() -> None:
    parser = argparse.ArgumentParser(prog="tracinator-desktop")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    set_launch_config(root=args.project_root)

    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="error")
    server = uvicorn.Server(config)
    set_server_ref(server)

    # Windows doesn't reparent orphans the same way (getppid() there just keeps
    # reporting the original, now-dead, creator PID rather than switching to a
    # live new parent), so this specific detection only applies on POSIX.
    if os.name == "posix":
        threading.Thread(target=_watch_parent, args=(server,), daemon=True).start()

    server.run()


if __name__ == "__main__":
    main()
