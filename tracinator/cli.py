import argparse
import sys
from pathlib import Path

from rich.console import Console


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="tracinator",
        description="Visualize Python function control flow as a terminal flowchart.",
    )
    subparsers = parser.add_subparsers(dest="command")

    debug_parser = subparsers.add_parser(
        "debug",
        help="Render the control flow graph of a Python function.",
    )
    debug_parser.add_argument("file", help="Path to the Python file")
    debug_parser.add_argument(
        "function",
        help="Name of the function to visualize. For a class method, use the "
        "dotted Class.method form (e.g. Foo.bar, Outer.Inner.method).",
    )
    debug_parser.add_argument(
        "--root",
        default=None,
        help="Project root directory (default: cwd)",
    )
    debug_parser.add_argument(
        "--depth",
        type=int,
        default=3,
        help="Max call depth to expand (default: 3)",
    )
    debug_parser.add_argument(
        "--no-calls",
        action="store_true",
        help="Do not expand called functions",
    )
    debug_parser.add_argument(
        "--wide",
        action="store_true",
        help="Use full terminal width",
    )
    debug_parser.add_argument(
        "--export",
        metavar="FILE",
        help="Export the chart to a text file",
    )
    debug_parser.add_argument(
        "--ui",
        action="store_true",
        help="Open the interactive web UI instead of terminal output",
    )
    debug_parser.add_argument(
        "--terminal",
        action="store_true",
        help="Force terminal output even if --ui is set",
    )
    debug_parser.add_argument(
        "--port",
        type=int,
        default=7331,
        help="Port for the web UI server (default: 7331)",
    )

    ui_parser = subparsers.add_parser(
        "ui",
        help="Open the interactive web UI (browse files and functions inside the app).",
    )
    ui_parser.add_argument(
        "--root",
        default=None,
        help="Project root directory to browse (default: cwd)",
    )
    ui_parser.add_argument(
        "--port",
        type=int,
        default=7331,
        help="Port for the web UI server (default: 7331)",
    )

    args = parser.parse_args()

    if args.command == "debug":
        _cmd_debug(args)
    else:
        _cmd_ui(args)


def _cmd_debug(args: argparse.Namespace) -> None:
    console = Console(stderr=True)

    file_path = str(Path(args.file).resolve())
    project_root = str(Path(args.root).resolve()) if args.root else str(Path.cwd())

    use_ui = args.ui or (not args.export and not args.terminal)

    if use_ui:
        depth = 0 if args.no_calls else args.depth
        _launch_ui(
            project_root=project_root,
            console=console,
            port=args.port,
            file_path=file_path,
            function_name=args.function,
            depth=depth,
        )
        return

    from tracinator.analyzer.context_builder import build_project_context
    from tracinator.renderer.terminal_renderer import TerminalRenderer

    max_depth = 0 if args.no_calls else args.depth

    try:
        ctx = build_project_context(
            file_path=file_path,
            function_name=args.function,
            project_root=project_root,
            max_call_depth=max_depth,
        )
    except FileNotFoundError as e:
        console.print(f"[bold red][tracinator error][/] {e}", highlight=False)
        sys.exit(1)
    except ValueError as e:
        console.print(f"[bold red][tracinator error][/] {e}", highlight=False)
        sys.exit(1)
    except SyntaxError as e:
        console.print(f"[bold red][tracinator error][/] {e}", highlight=False)
        sys.exit(1)

    import os
    if args.wide:
        try:
            width = os.get_terminal_size().columns
        except OSError:
            width = 200
    else:
        width = None

    renderer = TerminalRenderer(max_width=width)

    if args.export:
        from rich.console import Console as RichConsole
        export_console = RichConsole(
            file=open(args.export, "w", encoding="utf-8"),
            no_color=True,
            width=120,
        )
        cfg = _get_entry_cfg(ctx)
        if cfg:
            renderer.render_cfg(cfg, export_console)
        export_console.file.close()
        console.print(f"[green]Chart exported to {args.export}[/]")
    else:
        cfg = _get_entry_cfg(ctx)
        if cfg:
            renderer.render_cfg(cfg)


def _cmd_ui(args: argparse.Namespace) -> None:
    console = Console(stderr=True)
    root = getattr(args, 'root', None)
    port = getattr(args, 'port', 7331)
    project_root = str(Path(root).resolve()) if root else str(Path.cwd())
    _launch_ui(port=port, project_root=project_root, console=console)


def _launch_ui(
    project_root: str,
    console: Console,
    port: int = 7331,
    file_path: str = "",
    function_name: str = "",
    depth: int = 3,
) -> None:
    import threading
    import webbrowser
    import time

    from tracinator.server.app import app, set_launch_config
    import uvicorn

    set_launch_config(root=project_root, file=file_path, function=function_name, depth=depth)

    url = f"http://localhost:{port}/"

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    time.sleep(1.0)

    console.print(
        f"\n[bold green]⚡ Tracinator[/] running at [bold cyan]{url}[/]\n"
        f"[dim]Press Ctrl+C to stop[/]\n"
    )
    webbrowser.open(url)

    try:
        while thread.is_alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        console.print("\n[dim]Shutting down...[/]")
        server.should_exit = True


def _get_entry_cfg(ctx):
    cfg = ctx.all_graphs.get(ctx.entry_qualified_name)
    if cfg:
        return cfg

    # Fallback: first graph
    if ctx.all_graphs:
        return next(iter(ctx.all_graphs.values()))
    return None


if __name__ == "__main__":
    main()
