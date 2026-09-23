from __future__ import annotations

import textwrap
import venv
from pathlib import Path

from tracinator.tracer.capture import MAX_DEPTH, MAX_ITEMS, capture_value
from tracinator.tracer.event_tracer import run_trace, trace_call_tree
from tracinator.tracer.param_binding import get_param_names

FUNCTIONS_FILE = str(Path(__file__).parent.parent / "testing" / "01_basic_flow" / "functions.py")
MUTATION_FILE = str(Path(__file__).parent.parent / "testing" / "04_mutation_via_argument" / "mutation.py")
CLASSES_FILE = str(Path(__file__).parent.parent / "testing" / "05_classes" / "models.py")


# ─── capture_value ─────────────────────────────────────────────────────────

class TestCaptureValue:
    def test_immutable_gets_no_id(self):
        for value in (1, 1.5, "s", b"b", True, None, (1, 2), frozenset({1})):
            assert capture_value(value)["id"] is None

    def test_mutable_gets_id(self):
        obj = [1, 2]
        cap = capture_value(obj)
        assert cap["id"] == id(obj)

    def test_same_object_same_id_across_captures(self):
        obj = {"x": 1}
        assert capture_value(obj)["id"] == capture_value(obj)["id"]

    def test_repr_reflects_current_contents(self):
        obj = [1, 2]
        before = capture_value(obj)["items"]
        obj.append(3)
        after = capture_value(obj)["items"]
        assert [i["repr"] for i in before] == ["1", "2"]
        assert [i["repr"] for i in after] == ["1", "2", "3"]

    def test_plain_object_expands_into_fields_with_class_name_as_label(self):
        class Circle:
            def __init__(self, radius):
                self.radius = radius

        cap = capture_value(Circle(5))
        # No custom __repr__, so the ugly default `<...object at 0x...>` repr is
        # never computed — the class name is used as the label instead.
        assert cap["repr"] == "Circle"
        assert cap["type"] == "Circle"
        assert cap["fields"]["radius"]["repr"] == "5"

    def test_custom_repr_is_kept_as_label_but_still_expandable(self):
        class Point:
            def __init__(self, x, y):
                self.x = x
                self.y = y

            def __repr__(self):
                return f"Point({self.x}, {self.y})"

        cap = capture_value(Point(1, 2))
        assert cap["repr"] == "Point(1, 2)"
        assert cap["fields"]["x"]["repr"] == "1"
        assert cap["fields"]["y"]["repr"] == "2"

    def test_slots_class_reads_attrs_without_dict(self):
        class Slotted:
            __slots__ = ("a", "b")

            def __init__(self):
                self.a = 1
                self.b = 2

        cap = capture_value(Slotted())
        assert cap["type"] == "Slotted"
        assert cap["fields"]["a"]["repr"] == "1"
        assert cap["fields"]["b"]["repr"] == "2"

    def test_properties_are_not_invoked_during_capture(self):
        # Reading via __dict__/__slots__ only — never dir()+getattr() — so a
        # computed property can't run arbitrary code as a side effect of capture.
        calls = []

        class Sneaky:
            def __init__(self):
                self.stored = 1

            @property
            def computed(self):
                calls.append("accessed")
                return 2

        cap = capture_value(Sneaky())
        assert calls == []
        assert cap["fields"] == {"stored": {"repr": "1", "id": None}}

    def test_list_of_objects_expands_each_element(self):
        class Item:
            def __init__(self, n):
                self.n = n

        cap = capture_value([Item(1), Item(2)])
        assert cap["type"] == "list"
        assert [f["fields"]["n"]["repr"] for f in cap["items"]] == ["1", "2"]

    def test_dict_expands_keys_and_values(self):
        cap = capture_value({"a": 1, "b": 2})
        assert cap["type"] == "dict"
        assert [(e["key"]["repr"], e["value"]["repr"]) for e in cap["entries"]] == [
            ("'a'", "1"),
            ("'b'", "2"),
        ]

    def test_self_referential_object_does_not_hang_or_crash(self):
        class Node:
            pass

        node = Node()
        node.next = node  # cycle

        cap = capture_value(node)
        assert cap["fields"]["next"]["circular"] is True
        assert cap["fields"]["next"]["id"] == cap["id"]

    def test_sibling_repeats_of_the_same_object_are_not_treated_as_circular(self):
        class Leaf:
            def __init__(self):
                self.value = 1

        shared = Leaf()
        cap = capture_value([shared, shared])
        assert cap["items"][0].get("circular") is None
        assert cap["items"][1].get("circular") is None

    def test_large_list_is_truncated_at_max_items(self):
        cap = capture_value(list(range(MAX_ITEMS + 10)))
        assert len(cap["items"]) == MAX_ITEMS
        assert cap["truncated"] is True

    def test_deeply_nested_object_is_depth_limited(self):
        class Wrapper:
            def __init__(self, inner):
                self.inner = inner

        obj = "bottom"
        for _ in range(MAX_DEPTH + 5):
            obj = Wrapper(obj)

        cap = capture_value(obj)
        depth = 0
        node = cap
        while "fields" in node:
            depth += 1
            node = node["fields"]["inner"]
        assert depth == MAX_DEPTH
        assert node.get("truncated") is True


# ─── get_param_names ────────────────────────────────────────────────────────

class TestGetParamNames:
    def test_positional_and_keyword(self):
        def f(a, b, c=1):
            pass

        assert get_param_names(f.__code__) == {"a", "b", "c"}

    def test_kwonly(self):
        def f(a, *, b):
            pass

        assert get_param_names(f.__code__) == {"a", "b"}

    def test_varargs_and_varkwargs(self):
        def f(a, *args, **kwargs):
            pass

        assert get_param_names(f.__code__) == {"a", "args", "kwargs"}

    def test_no_params(self):
        def f():
            pass

        assert get_param_names(f.__code__) == set()


# ─── run_trace: call-tree structure ─────────────────────────────────────────

class TestCallTreeStructure:
    def _calls(self, events):
        return [e for e in events if e["event"] == "call" and e["frame_id"] is not None]

    def test_success_path_calls_get_user_and_charge(self):
        result = run_trace(FUNCTIONS_FILE, "process_payment", [500.0, "u1"])
        assert result["error"] is None
        calls = self._calls(result["events"])
        funcs = [c["func"] for c in calls]
        assert funcs == ["process_payment", "get_user", "charge"]

    def test_parent_frame_id_links_call_tree(self):
        result = run_trace(FUNCTIONS_FILE, "process_payment", [500.0, "u1"])
        calls = {c["func"]: c for c in self._calls(result["events"])}
        assert calls["process_payment"]["parent_frame_id"] is None
        assert calls["get_user"]["parent_frame_id"] == calls["process_payment"]["frame_id"]
        assert calls["charge"]["parent_frame_id"] == calls["process_payment"]["frame_id"]

    def test_call_line_points_to_the_call_site_in_the_parent(self):
        result = run_trace(FUNCTIONS_FILE, "process_payment", [500.0, "u1"])
        calls = {c["func"]: c for c in self._calls(result["events"])}
        # `user = get_user(user_id)` is line 2 of process_payment
        assert calls["get_user"]["call_line"] == 2
        # `charge(amount, user_id)` is line 7
        assert calls["charge"]["call_line"] == 7

    def test_insufficient_balance_path_skips_charge(self):
        result = run_trace(FUNCTIONS_FILE, "process_payment", [5000.0, "u1"])
        funcs = [c["func"] for c in self._calls(result["events"])]
        assert funcs == ["process_payment", "get_user", "notify_insufficient"]
        assert result["return_value"]["repr"] == "False"

    def test_params_captured_at_call_with_param_kind(self):
        result = run_trace(FUNCTIONS_FILE, "process_payment", [500.0, "u1"])
        calls = {c["func"]: c for c in self._calls(result["events"])}
        entry_locals = calls["process_payment"]["locals"]
        assert entry_locals["amount"]["kind"] == "param"
        assert entry_locals["amount"]["repr"] == "500.0"
        assert entry_locals["user_id"]["kind"] == "param"
        assert entry_locals["user_id"]["repr"] == "'u1'"

    def test_body_locals_appear_as_body_kind_after_assignment(self):
        result = run_trace(FUNCTIONS_FILE, "process_payment", [500.0, "u1"])
        entry_frame_id = self._calls(result["events"])[0]["frame_id"]
        body_events = [
            e for e in result["events"]
            if e["frame_id"] == entry_frame_id and "user" in e.get("locals", {})
        ]
        assert body_events, "expected a 'user' local to appear in process_payment's own frame"
        assert body_events[0]["locals"]["user"]["kind"] == "body"

    def test_return_value_captured(self):
        result = run_trace(FUNCTIONS_FILE, "process_payment", [500.0, "u1"])
        assert result["return_value"]["repr"] == "True"
        returns = [e for e in result["events"] if e["event"] == "return"]
        charge_return = next(e for e in returns if e["func"] == "charge")
        assert charge_return["return_value"]["repr"] == "None"


# ─── The bug this rewrite fixes: loop iterations must not overwrite each other ──

class TestLoopIterationsNotOverwritten:
    def test_each_iteration_of_a_loop_is_its_own_event(self):
        result = run_trace(FUNCTIONS_FILE, "loop_example", [[1, 2, 3]])
        item_values = [
            e["locals"]["item"]["repr"]
            for e in result["events"]
            if "item" in e.get("locals", {})
        ]
        # Old {line: locals} model would collapse this to just ["3"] (last write wins).
        assert item_values == ["1", "2", "3"]

    def test_result_list_growth_visible_across_iterations(self):
        result = run_trace(FUNCTIONS_FILE, "loop_example", [[1, 2, 3]])
        result_items = [
            [i["repr"] for i in e["locals"]["result"]["items"]]
            for e in result["events"]
            if "result" in e.get("locals", {})
        ]
        assert result_items == [[], ["1"], ["1", "2"], ["1", "2", "3"]]


# ─── Mutation across frames: identity must line up, no special-casing needed ──

class TestMutationAcrossFrames:
    def test_shared_list_has_same_id_in_both_frames(self):
        result = run_trace(MUTATION_FILE, "collect_bonus", [{"bonus": 50}, []])
        calls = {e["func"]: e for e in result["events"] if e["event"] == "call"}
        outer_id = calls["collect_bonus"]["locals"]["bonus_list"]["id"]
        inner_id = calls["add_bonus"]["locals"]["bonus_list"]["id"]
        assert outer_id is not None
        assert outer_id == inner_id

    def test_mutation_inside_callee_is_visible_in_callees_own_return_event(self):
        result = run_trace(MUTATION_FILE, "collect_bonus", [{"bonus": 50}, []])
        add_bonus_return = next(
            e for e in result["events"]
            if e["event"] == "return" and e["func"] == "add_bonus"
        )
        assert [i["repr"] for i in add_bonus_return["locals"]["bonus_list"]["items"]] == ["50"]

    def test_mutation_is_visible_back_in_the_caller_frame_too(self):
        result = run_trace(MUTATION_FILE, "collect_bonus", [{"bonus": 50}, []])
        caller_frame_id = next(
            e["frame_id"] for e in result["events"]
            if e["event"] == "call" and e["func"] == "collect_bonus"
        )
        caller_updates = [
            [i["repr"] for i in e["locals"]["bonus_list"]["items"]]
            for e in result["events"]
            if e["frame_id"] == caller_frame_id and "bonus_list" in e.get("locals", {})
        ]
        assert caller_updates[-1] == ["50"]
        assert [i["repr"] for i in result["return_value"]["items"]] == ["50"]

    def test_immutable_params_get_no_id_even_when_equal_by_value(self):
        result = run_trace(FUNCTIONS_FILE, "process_payment", [500.0, "u1"])
        calls = {e["func"]: e for e in result["events"] if e["event"] == "call"}
        assert calls["process_payment"]["locals"]["amount"]["id"] is None
        assert calls["charge"]["locals"]["amount"]["id"] is None


# ─── Global scope ───────────────────────────────────────────────────────────

class TestGlobalScope:
    def test_module_level_constant_captured_as_frame_zero(self, tmp_path):
        src = tmp_path / "with_global.py"
        src.write_text(textwrap.dedent("""
            TAX_RATE = 0.08

            def compute(amount):
                return amount * TAX_RATE
        """))
        result = run_trace(str(src), "compute", [100.0])
        global_events = [e for e in result["events"] if e["frame_id"] == 0]
        assert any(
            "TAX_RATE" in e.get("locals", {}) and e["locals"]["TAX_RATE"]["repr"] == "0.08"
            for e in global_events
        )

    def test_global_statement_mutation_is_captured_live(self, tmp_path):
        src = tmp_path / "mutates_global.py"
        src.write_text(textwrap.dedent("""
            counter = 0

            def bump():
                global counter
                counter += 1
                return counter
        """))
        result = run_trace(str(src), "bump", [])
        counter_reprs = [
            e["locals"]["counter"]["repr"]
            for e in result["events"]
            if e["frame_id"] == 0 and "counter" in e.get("locals", {})
        ]
        assert counter_reprs == ["0", "1"]

    def test_functions_and_modules_excluded_from_global_section(self, tmp_path):
        src = tmp_path / "funcs.py"
        src.write_text(textwrap.dedent("""
            import os

            def helper():
                pass

            def compute():
                return 1
        """))
        result = run_trace(str(src), "compute", [])
        global_events = [e for e in result["events"] if e["frame_id"] == 0]
        all_names = {name for e in global_events for name in e.get("locals", {})}
        assert "helper" not in all_names
        assert "os" not in all_names

    def test_function_frames_are_linked_to_their_module_global_scope(self, tmp_path):
        # Regression test: a function frame's own call/line/return events must carry
        # global_scope_id, even when that function never references any global by
        # name — otherwise the frontend has no way to know which global scope (frame_id
        # 0) belongs to a given function frame, and Global always renders empty.
        src = tmp_path / "unused_global.py"
        src.write_text(textwrap.dedent("""
            x = "hello world"

            def greet(name: str) -> str:
                if not name:
                    return "Hello, stranger!"
                return f"Hello, {name}!"
        """))
        result = run_trace(str(src), "greet", ["'world'"])
        call_event = next(e for e in result["events"] if e["event"] == "call" and e["func"] == "greet")
        assert call_event["global_scope_id"] == 0

        return_event = next(e for e in result["events"] if e["event"] == "return" and e["func"] == "greet")
        assert return_event["global_scope_id"] == 0

        global_events = [e for e in result["events"] if e["frame_id"] == 0]
        assert any("x" in e.get("locals", {}) and e["locals"]["x"]["repr"] == "'hello world'" for e in global_events)


# ─── Subprocess wrapper (trace_call_tree) end-to-end ────────────────────────

class TestKeywordOnlyArgs:
    # Regression: `fn(*arg_values)` used to pass every UI-collected value
    # positionally, which raises TypeError outright for any parameter after a
    # bare `*` in the def — those can only be passed by keyword. Reproduces the
    # real-world case (tracinator/tracer/capture.py's own
    # `capture_value(value, *, depth=0, seen=None)`), not a synthetic one.
    def test_function_with_keyword_only_params(self, tmp_path):
        src = tmp_path / "kwonly.py"
        src.write_text(textwrap.dedent("""
            def describe(value, *, depth=0, seen=None):
                return f"{value}:{depth}:{seen}"
        """))
        # run_trace takes already-evaluated arg values, in declaration order
        # (posonly + regular + kwonly) — same convention _bind_call_args relies
        # on. trace_call_tree (tested below) is the one that takes source strings.
        result = run_trace(str(src), "describe", ["x", 3, "s"])
        assert result["error"] is None
        assert result["return_value"]["repr"] == "'x:3:s'"

    def test_function_with_positional_only_params(self, tmp_path):
        src = tmp_path / "posonly.py"
        src.write_text(textwrap.dedent("""
            def add(a, b, /):
                return a + b
        """))
        result = run_trace(str(src), "add", [2, 3])
        assert result["error"] is None
        assert result["return_value"]["repr"] == "5"

    def test_instance_method_and_constructor_with_keyword_only_params(self, tmp_path):
        src = tmp_path / "kwonly_class.py"
        src.write_text(textwrap.dedent("""
            class Box:
                def __init__(self, size, *, label=""):
                    self.size = size
                    self.label = label

                def describe(self, *, prefix="box"):
                    return f"{prefix}:{self.size}:{self.label}"
        """))
        result = run_trace(str(src), "Box.describe", ["p"], [5, "L"])
        assert result["error"] is None
        assert result["return_value"]["repr"] == "'p:5:L'"

    def test_via_subprocess_with_source_expression_strings(self):
        # trace_call_tree (not run_trace) is what the API actually calls —
        # args here are Python expression *source*, evaluated in the subprocess.
        capture_path = str(Path(__file__).parent.parent / "tracinator" / "tracer" / "capture.py")
        result = trace_call_tree(capture_path, "capture_value", ["{1: 2}", "1", "frozenset()"])
        assert result["error"] is None
        funcs = [e["func"] for e in result["events"] if e["event"] == "call"]
        assert funcs[0] == "capture_value"


class TestTraceCallTreeSubprocess:
    def test_runs_via_subprocess_and_matches_in_process_result(self):
        result = trace_call_tree(FUNCTIONS_FILE, "process_payment", ["500.0", "'u1'"])
        assert result["error"] is None
        assert result["return_value"]["repr"] == "True"
        funcs = [e["func"] for e in result["events"] if e["event"] == "call"]
        assert funcs == ["process_payment", "get_user", "charge"]

    def test_timeout_raises_runtime_error(self, tmp_path):
        src = tmp_path / "hangs.py"
        src.write_text(textwrap.dedent("""
            def spin():
                while True:
                    pass
        """))
        try:
            trace_call_tree(str(src), "spin", [], timeout=1)
            assert False, "expected RuntimeError on timeout"
        except RuntimeError as e:
            assert "timed out" in str(e)


# ─── Call-site cap (repeated call sites / hot loops) ────────────────────────

class TestCallSiteCap:
    def test_calls_beyond_cap_are_dropped_with_a_marker(self, tmp_path):
        src = tmp_path / "hot_loop.py"
        src.write_text(textwrap.dedent("""
            def noop(i):
                return i

            def run():
                for i in range(10):
                    noop(i)
        """))
        from tracinator.tracer.event_tracer import EventTracer
        import importlib.util

        spec = importlib.util.spec_from_file_location("_m", str(src))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        tracer = EventTracer(call_site_cap=3)
        tracer.seed_entry_module_globals(mod.__dict__)
        import sys
        sys.settrace(tracer.global_trace)
        try:
            mod.run()
        finally:
            sys.settrace(None)

        noop_calls = [e for e in tracer.events if e["event"] == "call" and e["func"] == "noop"]
        markers = [e for e in tracer.events if e["event"] == "call_site_truncated"]
        assert len(noop_calls) == 3
        assert len(markers) == 1
        assert markers[0]["cap"] == 3


# ─── Class/method tracing: dotted names, constructor_args ──────────────────

class TestClassAndMethodTracing:
    def test_instance_method_traced_with_constructor_args(self):
        result = run_trace(CLASSES_FILE, "Base.base_method", [], [5])
        assert result["error"] is None
        assert result["return_value"]["repr"] == "10"
        funcs = [e["func"] for e in result["events"] if e["event"] == "call"]
        assert funcs == ["__init__", "base_method"]

    def test_entry_frame_id_points_at_the_traced_method_not_the_constructor(self):
        # The constructor call is a *sibling* of the traced method's call (both are
        # invoked separately from run_trace's own untraced frame, so neither is
        # nested under the other) — frame 1 is __init__, frame 2 is the method
        # actually being traced. Regression test for a bug where the frontend
        # defaulted to frame 1 and reported the method's own RETURN node as
        # "did not run" for any instance method traced with constructor args.
        result = run_trace(CLASSES_FILE, "Base.base_method", [], [5])
        calls = {e["func"]: e for e in result["events"] if e["event"] == "call"}
        assert calls["__init__"]["frame_id"] == 1
        assert calls["base_method"]["frame_id"] == 2
        assert result["entry_frame_id"] == 2

    def test_entry_frame_id_is_1_when_no_constructor_call_is_involved(self):
        result = run_trace(FUNCTIONS_FILE, "process_payment", [500.0, "u1"])
        assert result["entry_frame_id"] == 1

    def test_tracing_init_directly_runs_it_exactly_once(self):
        # Regression test: __init__ IS the constructor, so tracing it directly must
        # not also build a separate instance first (that would run it twice, once
        # per set of "constructor args"/"method args" the old code asked for).
        result = run_trace(CLASSES_FILE, "Base.__init__", [5], [])
        assert result["error"] is None
        funcs = [e["func"] for e in result["events"] if e["event"] == "call"]
        assert funcs == ["__init__"]
        assert result["entry_frame_id"] == 1
        assert result["return_value"]["repr"] == "None"
        # The instance actually got initialized despite skipping cls(...).
        init_call = next(e for e in result["events"] if e["event"] == "call")
        assert init_call["locals"]["value"]["repr"] == "5"

    def test_classmethod_call_does_not_need_constructor_args(self):
        result = run_trace(CLASSES_FILE, "Factory.create", [5], [])
        assert result["error"] is None
        # create() returns cls(value) — a Factory instance, not a plain repr.
        assert result["return_value"]["type"] == "Factory"

    def test_staticmethod_call(self):
        result = run_trace(CLASSES_FILE, "Factory.double", [21], [])
        assert result["error"] is None
        assert result["return_value"]["repr"] == "42"

    def test_missing_required_constructor_arg_surfaces_as_error_not_crash(self):
        result = run_trace(CLASSES_FILE, "Account.describe", [], [])
        assert result["error"] is not None
        assert "owner" in result["error"]

    def test_nested_class_method_traced(self):
        result = run_trace(CLASSES_FILE, "Outer.Inner.greet", [], [])
        assert result["error"] is None
        assert result["return_value"]["repr"] == "'hello from inner'"

    def test_subprocess_wrapper_passes_constructor_args_through(self):
        result = trace_call_tree(CLASSES_FILE, "Base.base_method", [], ["5"])
        assert result["error"] is None
        assert result["return_value"]["repr"] == "10"


# ─── Interpreter separation: `python_executable` runs the *traced* code, not
# necessarily the interpreter running tracinator's own server ──────────────

class TestInterpreterSeparation:
    def _make_second_venv_with_fake_package(self, tmp_path: Path) -> Path:
        # A bare venv (no pip, no network) with a package planted directly in its
        # site-packages — enough to prove `python_executable` controls which
        # interpreter's import path is used, without needing a real network
        # install of something like numpy.
        venv_dir = tmp_path / "second_venv"
        venv.create(venv_dir, with_pip=False)
        py = venv_dir / "bin" / "python3"
        site_packages = next((venv_dir / "lib").glob("python*/site-packages"))
        (site_packages / "only_in_second_venv.py").write_text(
            'MARKER = "planted-in-second-venv"\n'
        )
        return py

    def test_default_interpreter_cannot_see_the_second_venvs_package(self, tmp_path):
        src = tmp_path / "needs_second_venv.py"
        src.write_text(textwrap.dedent("""
            import only_in_second_venv

            def use_marker():
                return only_in_second_venv.MARKER
        """))
        # The import fails at module-exec time, before run_trace's own try/except
        # is even entered, so it kills the subprocess outright (non-zero exit)
        # rather than coming back as a populated `error` field.
        try:
            trace_call_tree(str(src), "use_marker", [])
            assert False, "expected RuntimeError — default interpreter lacks only_in_second_venv"
        except RuntimeError as e:
            assert "only_in_second_venv" in str(e)

    def test_explicit_python_executable_can_import_a_package_only_it_has(self, tmp_path):
        second_python = self._make_second_venv_with_fake_package(tmp_path)
        src = tmp_path / "needs_second_venv.py"
        src.write_text(textwrap.dedent("""
            import only_in_second_venv

            def use_marker():
                return only_in_second_venv.MARKER
        """))
        result = trace_call_tree(str(src), "use_marker", [], python_executable=str(second_python))
        assert result["error"] is None
        assert result["return_value"]["repr"] == "'planted-in-second-venv'"
