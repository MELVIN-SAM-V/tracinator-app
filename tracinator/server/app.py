from __future__ import annotations
import ast
import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from tracinator.analyzer.call_resolver import CallResolver
from tracinator.analyzer.class_registry import build_class_registry, iter_defs
from tracinator.analyzer.context_builder import build_project_context
from tracinator.server.function_listing import find_init_same_file, function_item
from tracinator.server.serializer import serialize_context
from tracinator.tracer.event_tracer import trace_call_tree

app = FastAPI(title="Tracinator API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_launch_config: dict = {}
_project_root: str = str(Path.cwd())
_python_executable_override: str | None = None
_server_ref = None

_BROWSE_EXCLUDES = {'.git', '.venv', 'venv', '__pycache__', 'node_modules', '.mypy_cache', '.pytest_cache', 'dist', 'build'}

_VENV_PYTHON_SUBPATH = (
    ("Scripts", "python.exe") if sys.platform == "win32" else ("bin", "python")
)


def set_launch_config(root: str, file: str = "", function: str = "", depth: int = 3) -> None:
    global _project_root
    _project_root = root
    _launch_config.update({"file": file, "function": function, "depth": depth, "root": root})


def set_python_executable_override(path: str | None) -> None:
    global _python_executable_override
    _python_executable_override = path


def set_server_ref(server) -> None:
    """Lets a `uvicorn.Server` be shut down from within a route (`/api/shutdown`)
    without `app.py` owning process lifecycle itself. Only the desktop launcher
    calls this — `cli.py`/`dev_app.sh` never do, so `/api/shutdown` is inert there.
    """
    global _server_ref
    _server_ref = server


def resolve_python_executable(project_root: str) -> str | None:
    """The interpreter used to run *traced* code, kept separate from whichever
    interpreter is running tracinator's own server (`sys.executable`) — see
    `trace_call_tree`'s `python_executable` param. An explicit override always
    wins; otherwise auto-detect a `.venv`/`venv` under the project root (the
    convention `_BROWSE_EXCLUDES` above already assumes); otherwise fall back
    to whatever `python3`/`python` resolves to on PATH.
    """
    if _python_executable_override:
        return _python_executable_override
    root = Path(project_root)
    for venv_name in (".venv", "venv"):
        candidate = root / venv_name / Path(*_VENV_PYTHON_SUBPATH)
        if candidate.exists():
            return str(candidate)
    return shutil.which("python3") or shutil.which("python")


class SourceRequest(BaseModel):
    source: str
    function: str
    depth: int = 3


class SourceBody(BaseModel):
    source: str


@app.post("/api/graph-from-source")
async def graph_from_source(body: SourceRequest):
    with tempfile.NamedTemporaryFile(suffix=".py", mode="w", encoding="utf-8", delete=False) as f:
        f.write(body.source)
        tmp_path = f.name
    try:
        ctx = build_project_context(
            file_path=tmp_path,
            function_name=body.function,
            project_root=os.path.dirname(tmp_path),
            max_call_depth=body.depth,
        )
        return JSONResponse(content=serialize_context(ctx))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except SyntaxError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/functions-from-source")
async def functions_from_source(body: SourceBody):
    try:
        tree = ast.parse(body.source)
    except SyntaxError:
        return JSONResponse(content={"functions": []})
    registry = build_class_registry(tree, source_file="<source>")
    functions = [
        function_item(entry, lambda cn: find_init_same_file(registry, cn))
        for entry in iter_defs(tree)
    ]
    return JSONResponse(content={"functions": functions})


class TraceRequest(BaseModel):
    file: str
    function: str
    args: list[str]
    constructor_args: list[str] = []


@app.post("/api/trace")
async def trace(body: TraceRequest):
    path = Path(body.file)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {body.file}")
    try:
        result = trace_call_tree(
            str(path),
            body.function,
            body.args,
            body.constructor_args,
            python_executable=resolve_python_executable(_project_root),
        )
    except RuntimeError as e:
        result = {"events": [], "return_value": None, "error": str(e), "truncated": False}
    return JSONResponse(content=result)


@app.get("/api/graph")
async def get_graph(
    file: str = Query(...),
    function: str = Query(...),
    depth: int = Query(3),
    root: str = Query(None),
    no_calls: bool = Query(False),
):
    project_root = root or str(Path.cwd())
    max_depth = 0 if no_calls else depth
    try:
        ctx = build_project_context(
            file_path=str(Path(file).resolve()),
            function_name=function,
            project_root=project_root,
            max_call_depth=max_depth,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except SyntaxError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(content=serialize_context(ctx))


@app.get("/api/source")
async def get_source(
    file: str = Query(...),
    start_line: int = Query(1),
    end_line: int = Query(None),
):
    path = Path(file)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {file}")
    try:
        all_lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
    s = max(0, start_line - 1)
    e = end_line if end_line else len(all_lines)
    return {"lines": all_lines[s:e]}


@app.get("/api/health")
async def health():
    return JSONResponse(content={"status": "ok"})


@app.post("/api/shutdown")
async def shutdown():
    if _server_ref is not None:
        _server_ref.should_exit = True
    return JSONResponse(content={"status": "ok"})


@app.get("/api/config")
async def get_config():
    return JSONResponse(content={
        "root": _project_root,
        **_launch_config,
        "python_executable": resolve_python_executable(_project_root),
    })


class PythonExecutableRequest(BaseModel):
    path: str | None = None


@app.post("/api/python-executable")
async def set_python_executable(body: PythonExecutableRequest):
    if body.path is not None and not Path(body.path).exists():
        raise HTTPException(status_code=404, detail=f"Interpreter not found: {body.path}")
    set_python_executable_override(body.path)
    return JSONResponse(content={"python_executable": resolve_python_executable(_project_root)})


@app.get("/api/browse")
async def browse(path: str = Query(None)):
    target = Path(path).resolve() if path else Path(_project_root).resolve()
    root = Path(_project_root).resolve()

    # Security: must be within project root
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path is outside project root")

    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    dirs = sorted(
        d.name for d in target.iterdir()
        if d.is_dir() and d.name not in _BROWSE_EXCLUDES and not d.name.startswith('.')
    )
    files = sorted(
        f.name for f in target.iterdir()
        if f.is_file() and f.suffix == '.py'
    )

    parent = str(target.parent) if target != root else None

    return JSONResponse(content={
        "path": str(target),
        "parent": parent,
        "dirs": dirs,
        "files": files,
    })


@app.get("/api/functions")
async def get_functions(file: str = Query(...)):
    path = Path(file).resolve()
    root = Path(_project_root).resolve()

    try:
        path.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="File is outside project root")

    if not path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {file}")
    if path.suffix != '.py':
        raise HTTPException(status_code=400, detail="Only .py files are supported")

    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except SyntaxError as e:
        raise HTTPException(status_code=400, detail=f"Syntax error: {e}")
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))

    resolver = CallResolver(root, {})

    def _constructor_lookup(class_name: str):
        found = resolver.find_method_via_mro(str(path), class_name, "__init__")
        return found[1] if found else None

    functions = [function_item(entry, _constructor_lookup) for entry in iter_defs(tree)]

    return JSONResponse(content={"functions": functions})


# Serve built frontend if dist exists
_dist = Path(__file__).parent.parent / "ui" / "dist"
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=str(_dist / "assets")), name="assets")

    @app.get("/", response_class=HTMLResponse)
    async def serve_index():
        html = (_dist / "index.html").read_text()
        return HTMLResponse(content=html)

    @app.get("/{full_path:path}", response_class=HTMLResponse)
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        html = (_dist / "index.html").read_text()
        return HTMLResponse(content=html)
