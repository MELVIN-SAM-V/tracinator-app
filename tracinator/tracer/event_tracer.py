from __future__ import annotations

import importlib.util
import inspect
import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

from tracinator.tracer.capture import capture_value
from tracinator.tracer.param_binding import get_param_names

DEFAULT_EVENT_CAP = 200_000
DEFAULT_CALL_SITE_CAP = 2_000


def _is_global_worth_tracking(name: str, value: object) -> bool:
    if name.startswith("__") and name.endswith("__"):
        return False
    # Function/class/module bindings are the module's *code*, not its data —
    # the Global panel is for variables like `TAX_RATE = 0.08`, not `def charge(...)`.
    return not (inspect.ismodule(value) or inspect.isroutine(value) or inspect.isclass(value))


class EventTracer:
    """Traces a whole call tree in one `sys.settrace` run, emitting a flat
    chronological event log.

    frame_id 0 is reserved for the entry module's global scope (seeded before
    tracing starts). Real function invocations get frame_id 1, 2, 3, ... in the
    order their `call` event fires. Other modules' global scopes (cross-file
    calls) are assigned the next free id the first time one of their frames is
    seen — an extension of the doc's single-module description to the
    multi-file case, since each module has its own independent global namespace.
    """

    def __init__(
        self,
        event_cap: int = DEFAULT_EVENT_CAP,
        call_site_cap: int = DEFAULT_CALL_SITE_CAP,
    ) -> None:
        self.events: list[dict] = []
        self.seq = 0
        self.next_frame_id = 1
        self.stack: list[int] = []
        self.frame_meta: dict[int, dict] = {}
        self.frame_param_names: dict[int, set[str]] = {}
        self.frame_cache: dict[int, dict[str, tuple]] = {}
        self.global_scope_ids: dict[int, int] = {}
        self.global_cache: dict[int, dict[str, tuple]] = {}
        self.call_site_counts: dict[tuple, int] = {}
        self.event_cap = event_cap
        self.call_site_cap = call_site_cap
        self.truncated = False
        self._tracing_enabled = True

    # ── Global scope (the "Global" panel section) ──────────────────────────

    def seed_entry_module_globals(self, globals_dict: dict) -> None:
        gid = id(globals_dict)
        self.global_scope_ids[gid] = 0
        self.global_cache[0] = {}
        self._diff_and_emit_globals(0, globals_dict, line=None)

    def _get_or_assign_global_scope(self, globals_dict: dict) -> int:
        gid = id(globals_dict)
        if gid not in self.global_scope_ids:
            scope_id = self.next_frame_id
            self.next_frame_id += 1
            self.global_scope_ids[gid] = scope_id
            self.global_cache[scope_id] = {}
        return self.global_scope_ids[gid]

    def _diff_and_emit_globals(self, scope_id: int, globals_dict: dict, line: int | None) -> None:
        cache = self.global_cache[scope_id]
        changed = {}
        for name, value in list(globals_dict.items()):
            if not _is_global_worth_tracking(name, value):
                continue
            cap = capture_value(value)
            key = (cap["id"], cap["repr"])
            if cache.get(name) != key:
                cache[name] = key
                changed[name] = {**cap, "kind": "global"}
        if changed:
            self._emit(
                event="line",
                frame_id=scope_id,
                parent_frame_id=None,
                func="<module>",
                file=globals_dict.get("__file__"),
                line=line,
                call_line=None,
                locals=changed,
            )

    # ── Function frames (Caller / State panel sections) ────────────────────

    def global_trace(self, frame, event, arg):
        if not self._tracing_enabled:
            return None
        if event == "call":
            return self._on_call(frame)
        return None

    def _on_call(self, frame):
        parent_id = self.stack[-1] if self.stack else None
        call_line = frame.f_back.f_lineno if (frame.f_back and parent_id is not None) else None
        site_key = (parent_id, call_line)
        count = self.call_site_counts.get(site_key, 0) + 1
        self.call_site_counts[site_key] = count
        if count > self.call_site_cap:
            if count == self.call_site_cap + 1:
                self._emit(
                    event="call_site_truncated",
                    frame_id=None,
                    parent_frame_id=parent_id,
                    func=frame.f_code.co_name,
                    file=frame.f_code.co_filename,
                    line=frame.f_lineno,
                    call_line=call_line,
                    locals={},
                    cap=self.call_site_cap,
                )
            return None

        frame_id = self.next_frame_id
        self.next_frame_id += 1
        self.stack.append(frame_id)
        param_names = get_param_names(frame.f_code)
        self.frame_param_names[frame_id] = param_names
        self.frame_cache[frame_id] = {}
        global_scope_id = self._get_or_assign_global_scope(frame.f_globals)
        self.frame_meta[frame_id] = {
            "parent": parent_id,
            "call_line": call_line,
            "func": frame.f_code.co_name,
            "file": frame.f_code.co_filename,
            "global_scope_id": global_scope_id,
        }

        captured = {}
        for name, value in frame.f_locals.items():
            cap = capture_value(value)
            self.frame_cache[frame_id][name] = (cap["id"], cap["repr"])
            captured[name] = {**cap, "kind": "param"}
        self._emit(
            event="call",
            frame_id=frame_id,
            parent_frame_id=parent_id,
            func=frame.f_code.co_name,
            file=frame.f_code.co_filename,
            line=frame.f_lineno,
            call_line=call_line,
            locals=captured,
            global_scope_id=global_scope_id,
        )
        return self._make_local_tracer(frame_id)

    def _make_local_tracer(self, frame_id: int):
        def local_trace(frame, event, arg):
            if not self._tracing_enabled:
                return None
            if event == "line":
                self._on_line(frame, frame_id)
            elif event == "return":
                self._on_return(frame, frame_id, arg)
            return local_trace

        return local_trace

    def _diff_locals(self, frame, frame_id: int, param_names: set[str]) -> dict:
        cache = self.frame_cache[frame_id]
        changed = {}
        for name, value in frame.f_locals.items():
            cap = capture_value(value)
            key = (cap["id"], cap["repr"])
            if cache.get(name) != key:
                cache[name] = key
                kind = "param" if name in param_names else "body"
                changed[name] = {**cap, "kind": kind}
        return changed

    def _on_line(self, frame, frame_id: int) -> None:
        changed = self._diff_locals(frame, frame_id, self.frame_param_names[frame_id])
        meta = self.frame_meta[frame_id]
        # Always emit, even with no local changes: a 'line' event marks "about to run
        # this line," so an unconditional-check or no-op line still needs its own seq
        # to anchor "state right after the *previous* line finished" — the UI resolves
        # a clicked node's value from the very next event's seq, wherever it lands.
        self._emit(
            event="line",
            frame_id=frame_id,
            parent_frame_id=meta["parent"],
            func=meta["func"],
            file=meta["file"],
            line=frame.f_lineno,
            call_line=meta["call_line"],
            locals=changed,
            global_scope_id=meta["global_scope_id"],
        )
        self._maybe_emit_global_changes(frame)

    def _on_return(self, frame, frame_id: int, arg) -> None:
        changed = self._diff_locals(frame, frame_id, self.frame_param_names[frame_id])
        meta = self.frame_meta[frame_id]
        self._emit(
            event="return",
            frame_id=frame_id,
            parent_frame_id=meta["parent"],
            func=meta["func"],
            file=meta["file"],
            line=frame.f_lineno,
            call_line=meta["call_line"],
            locals=changed,
            return_value=capture_value(arg),
            global_scope_id=meta["global_scope_id"],
        )
        self._maybe_emit_global_changes(frame)
        if self.stack and self.stack[-1] == frame_id:
            self.stack.pop()
        del self.frame_cache[frame_id]
        del self.frame_param_names[frame_id]
        del self.frame_meta[frame_id]

    def _maybe_emit_global_changes(self, frame) -> None:
        scope_id = self._get_or_assign_global_scope(frame.f_globals)
        self._diff_and_emit_globals(scope_id, frame.f_globals, line=frame.f_lineno)

    # ── Emission ─────────────────────────────────────────────────────────

    def _emit(self, **fields) -> None:
        if self.event_cap and len(self.events) >= self.event_cap:
            self.truncated = True
            self._tracing_enabled = False
            return
        event = {"return_value": None, "global_scope_id": None, **fields, "seq": self.seq}
        self.seq += 1
        self.events.append(event)


def _bind_call_args(target: object, arg_values: list) -> tuple[list, dict]:
    """Splits `arg_values` (already in declaration order — see `_declared_param_names`
    in `tracinator/server/function_listing.py`, the UI-side counterpart this must stay
    aligned with) into a positional list and a by-name dict suitable for `target(*pos,
    **kw)`. Keyword-only parameters (anything after a bare `*` in the def) can't be
    passed positionally at all — `fn(*arg_values)` would raise TypeError the moment one
    is supplied — so they're matched to their declared name and passed by keyword
    instead; positional-only and regular parameters stay positional. `*args`/`**kwargs`
    are excluded from `inspect.signature` before pairing since the UI never collects a
    value for them (there's no single value to prompt for), and they'd otherwise shift
    every keyword-only parameter after them out of alignment with `arg_values`.
    """
    named_params = [
        p
        for p in inspect.signature(target).parameters.values()
        if p.kind not in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
    ]
    pos: list = []
    kw: dict = {}
    for param, value in zip(named_params, arg_values):
        if param.kind == inspect.Parameter.KEYWORD_ONLY:
            kw[param.name] = value
        else:
            pos.append(value)
    return pos, kw


def run_trace(
    file_path: str,
    function_name: str,
    arg_values: list,
    constructor_arg_values: list | None = None,
) -> dict:
    """In-process entry point: import the target module (untraced), then trace
    the whole call tree of `function_name(*arg_values)`. Returns a JSON-safe dict.

    `function_name` may be a bare function name, or a dotted class-relative method
    name (e.g. "Foo.bar", "Outer.Inner.method") — the latter is resolved by walking
    attribute access from the module, then binding according to the method's
    *runtime* kind (`inspect.getattr_static`, independent of the AST-derived
    `method_kind` the API ships — that one only drives the frontend's decision to
    show a constructor-args section).
    """
    sys.path.insert(0, str(Path(file_path).parent))
    spec = importlib.util.spec_from_file_location("_tracinator_traced_module", file_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    tracer = EventTracer()
    tracer.seed_entry_module_globals(mod.__dict__)

    error = None
    return_value_cap = None
    entry_frame_id = None
    # Redirect stdout to a C-implemented buffer (not a Python-level object) for the
    # duration of the traced call: the target's own print()s must not (a) land on the
    # subprocess's real stdout, which trace_call_tree reserves for the final JSON line,
    # or (b) go through a Python-level stream (e.g. a test runner's capture shim),
    # whose .write() would itself be traced as just another call in the event log.
    real_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        # Attribute-walk / getattr_static happen BEFORE settrace is armed — they're
        # binding-resolution machinery, not part of the traced program, and would
        # otherwise leak their own internals (e.g. getattr_static's helpers) into the
        # event log. Constructor instantiation happens *inside* the traced region
        # (and inside this try) so it shows up in the event log like any other call,
        # and so a missing-required-arg TypeError surfaces via the existing
        # `error = repr(e)` path — no new error handling needed.
        parts = function_name.split(".")
        if len(parts) == 1:
            fn = getattr(mod, function_name)
            sys.settrace(tracer.global_trace)
        else:
            *class_path, method_name = parts
            obj = mod
            for part in class_path:
                obj = getattr(obj, part)
            cls = obj
            raw = inspect.getattr_static(cls, method_name)
            sys.settrace(tracer.global_trace)
            if isinstance(raw, (staticmethod, classmethod)):
                fn = getattr(cls, method_name)
            elif method_name == "__init__":
                # __init__ *is* the constructor — building an instance via cls(...) to
                # get something to call it on would already run it once, then calling
                # it again explicitly (the pattern below) would run it a second time
                # with a separate, redundant set of arguments. Build a raw, uninitialized
                # instance instead (no __init__ side effects yet) and call __init__
                # exactly once, under tracing, with the one set of arguments the UI asks
                # for — there's no separate "constructor args" to duplicate here.
                instance = cls.__new__(cls)
                fn = instance.__init__
            else:
                # inspect.signature() below is binding-resolution machinery like
                # getattr_static above, not part of the traced program — pause
                # tracing around it so its own internals (Signature.from_callable,
                # unwrap, ...) don't leak into the event log as spurious calls,
                # same reasoning as the capture_value call at the bottom of this
                # function. Re-armed immediately after, before the actual (tracked)
                # constructor call.
                sys.settrace(None)
                ctor_pos, ctor_kw = _bind_call_args(cls, constructor_arg_values or [])
                sys.settrace(tracer.global_trace)
                instance = cls(*ctor_pos, **ctor_kw)
                fn = getattr(instance, method_name)
        # The constructor call above (if any) is traced too and gets its own frame_id
        # ahead of this one, so the traced function's own frame is NOT always frame 1
        # — it's whatever `next_frame_id` is about to hand out right before this call.
        entry_frame_id = tracer.next_frame_id
        sys.settrace(None)
        pos, kw = _bind_call_args(fn, arg_values)
        sys.settrace(tracer.global_trace)
        result = fn(*pos, **kw)
        # Tracing must be off before this: capture_value is plain Python (unlike the
        # repr() it replaced, which was a C builtin and so invisible to sys.settrace),
        # and this call happens in run_trace's own frame — not from inside a trace
        # callback — so with tracing still armed it would itself generate spurious
        # 'call' events for capture_value and its helpers.
        sys.settrace(None)
        return_value_cap = capture_value(result)
    except Exception as e:
        error = repr(e)
    finally:
        sys.settrace(None)
        sys.stdout = real_stdout

    return {
        "events": tracer.events,
        "entry_frame_id": entry_frame_id,
        "return_value": return_value_cap,
        "error": error,
        "truncated": tracer.truncated,
    }


def trace_call_tree(
    file_path: str,
    function_name: str,
    args: list[str],
    constructor_args: list[str] | None = None,
    timeout: int = 5,
    python_executable: str | None = None,
    work_dir: str | None = None,
    scrub_cloud_credentials: bool = False,
) -> dict:
    """Run `function_name` from `file_path` with `args` (Python expression-source
    strings, e.g. `"'hello'"`, `"[1, 2, 3]"`) in a subprocess, tracing the whole
    call tree. `constructor_args` (same expression-source convention) are passed
    through to build the instance when `function_name` is a dotted instance-method
    name. Returns `run_trace`'s dict. Raises RuntimeError on timeout or
    unrecoverable subprocess failure.

    `python_executable` selects the interpreter that runs the *traced* code —
    it needs the traced project's own dependencies on its path, which is a
    separate concern from whatever interpreter is running tracinator's own
    server (`sys.executable`, the default when this is left `None`). Only
    `tracinator.tracer.event_tracer` itself (stdlib-only) gets imported in the
    subprocess, via PYTHONPATH below, so any Python 3 interpreter works here
    regardless of whether tracinator's own server dependencies are installed
    on it.

    `work_dir` is where the generated harness script is written. The script's
    directory becomes `sys.path[0]` in the subprocess, so a shared directory
    (the default temp dir) lets files left there by an earlier request shadow
    stdlib modules — pass a fresh per-request directory when running
    untrusted code. `scrub_cloud_credentials` drops `AWS_*` variables from
    the subprocess environment.
    """
    args_source = ", ".join(args)
    ctor_args_source = ", ".join(constructor_args or [])
    script = textwrap.dedent(f"""\
        import json
        from tracinator.tracer.event_tracer import run_trace

        _result = run_trace({file_path!r}, {function_name!r}, [{args_source}], [{ctor_args_source}])
        print(json.dumps(_result))
        """)

    with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False, encoding="utf-8", dir=work_dir) as f:
        f.write(script)
        tmp = f.name

    # AWS Lambda makes /var/task importable by mutating the running
    # interpreter's sys.path in memory at cold start, not via PYTHONPATH —
    # so a freshly spawned subprocess never inherits it and can't find
    # `tracinator`. Deriving the package root from this file's own location
    # covers both that case (resolves to /var/task) and any other install
    # layout the parent process can already see.
    package_root = str(Path(__file__).resolve().parent.parent.parent)
    env = os.environ.copy()
    if scrub_cloud_credentials:
        env = {k: v for k, v in env.items() if not k.startswith("AWS_")}
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [package_root, env.get("PYTHONPATH")]))

    try:
        result = subprocess.run(
            [python_executable or sys.executable, tmp],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(Path(file_path).parent),
            env=env,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Trace timed out after {timeout}s — possible infinite loop")
    finally:
        os.unlink(tmp)

    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"Tracer exited with code {result.returncode}")

    return json.loads(result.stdout)
