from __future__ import annotations
import ast
import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from mangum import Mangum
from pydantic import BaseModel

from tracinator.analyzer.class_registry import build_class_registry, iter_defs
from tracinator.analyzer.context_builder import build_project_context
from tracinator.server.function_listing import find_init_same_file, function_item
from tracinator.server.sandbox_guard import UnsafeSourceError, check_source_safety
from tracinator.server.serializer import serialize_context
from tracinator.tracer.event_tracer import trace_call_tree

# Public demo surface only: no filesystem browsing, no static file serving,
# no /api/trace (file-path based — see trace_from_source below for why the
# demo needs its own self-contained variant instead of reusing it).
app = FastAPI(title="Tracinator Demo API")

MAX_SOURCE_BYTES = 50_000
MAX_DEPTH = 6


def _make_process_undumpable() -> None:
    # A same-uid child (the traced snippet) can otherwise read this process's
    # /proc/<pid>/environ — on Lambda, that holds the execution role's
    # credentials. Best effort: non-Linux platforms simply lack prctl.
    try:
        import ctypes

        ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE = 4
    except (OSError, AttributeError, TypeError):
        pass


_make_process_undumpable()


@contextmanager
def _request_dir() -> Iterator[Path]:
    # A warm Lambda container reuses /tmp across requests. Python puts the
    # script's directory first on sys.path, so a shared /tmp would let one
    # visitor's leftover files (e.g. a json.py) run inside the next visitor's
    # request. Every request gets its own empty directory instead.
    path = Path(tempfile.mkdtemp(prefix="demo-"))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _check_source_size(source: str) -> None:
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=400, detail=f"Source exceeds the {MAX_SOURCE_BYTES}-byte demo limit")


class SourceRequest(BaseModel):
    source: str
    function: str
    depth: int = 3


class SourceBody(BaseModel):
    source: str


class TraceFromSourceRequest(BaseModel):
    source: str
    function: str
    args: list[str] = []
    constructor_args: list[str] = []


@app.post("/api/graph-from-source")
async def graph_from_source(body: SourceRequest):
    _check_source_size(body.source)
    depth = min(body.depth, MAX_DEPTH)
    with _request_dir() as workdir:
        snippet = workdir / "snippet.py"
        snippet.write_text(body.source, encoding="utf-8")
        try:
            ctx = build_project_context(
                file_path=str(snippet),
                function_name=body.function,
                project_root=str(workdir),
                max_call_depth=depth,
            )
            return JSONResponse(content=serialize_context(ctx))
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except (ValueError, SyntaxError) as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/functions-from-source")
async def functions_from_source(body: SourceBody):
    _check_source_size(body.source)
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


@app.post("/api/trace-from-source")
async def trace_from_source(body: TraceFromSourceRequest):
    _check_source_size(body.source)
    try:
        check_source_safety(body.source)
    except SyntaxError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except UnsafeSourceError as e:
        raise HTTPException(status_code=400, detail=str(e))

    with _request_dir() as workdir:
        snippet = workdir / "snippet.py"
        snippet.write_text(body.source, encoding="utf-8")
        try:
            result = trace_call_tree(
                str(snippet),
                body.function,
                body.args,
                body.constructor_args,
                work_dir=str(workdir),
                scrub_cloud_credentials=True,
            )
        except RuntimeError as e:
            result = {"events": [], "return_value": None, "error": str(e), "truncated": False}
    return JSONResponse(content=result)


handler = Mangum(app)
