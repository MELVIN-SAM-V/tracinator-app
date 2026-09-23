from __future__ import annotations

import ast
import textwrap
from pathlib import Path

from tracinator.analyzer.call_resolver import CallResolver, MethodContext
from tracinator.analyzer.context_builder import build_project_context
from tracinator.models import MethodKind, NodeType

FIXTURE_ROOT = str(Path(__file__).parent.parent / "testing" / "05_classes")
MODELS_FILE = str(Path(FIXTURE_ROOT) / "models.py")
SHAPES_FILE = str(Path(FIXTURE_ROOT) / "shapes.py")


def _resolver() -> CallResolver:
    return CallResolver(FIXTURE_ROOT, {})


def _method_ctx(resolver: CallResolver, class_name: str, self_param: str = "self") -> MethodContext:
    return MethodContext(
        class_name=class_name,
        self_param=self_param,
        is_bound=True,
        method_kind=MethodKind.INSTANCE,
    )


def _first_call_sig(resolver: CallResolver, source: str, current_file: str, method_ctx=None):
    tree = ast.parse(textwrap.dedent(source))
    func_node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef))
    call_node = next(n for n in ast.walk(func_node) if isinstance(n, ast.Call))
    local_functions = {}
    return resolver.resolve_call(call_node, current_file, local_functions, method_ctx)


# ─── self./cls. resolution (by position, not literal name) ───────────────────

class TestSelfClsResolution:
    def test_self_dot_call_resolves_to_own_method(self):
        resolver = _resolver()
        ctx = _method_ctx(resolver, "Base")
        sig = _first_call_sig(resolver, """
            def bar(self):
                return self.base_method()
        """, MODELS_FILE, ctx)
        assert sig is not None
        assert sig.qualified_name == "models.Base.base_method"

    def test_self_dot_call_resolves_through_inheritance_mro(self):
        # Derived doesn't define base_method itself — must walk the MRO to Base.
        resolver = _resolver()
        ctx = _method_ctx(resolver, "Derived", self_param="this")
        sig = _first_call_sig(resolver, """
            def derived_method(this):
                return this.base_method()
        """, MODELS_FILE, ctx)
        assert sig is not None
        assert sig.qualified_name == "models.Base.base_method"

    def test_diamond_inheritance_first_match_wins(self):
        # Diamond(Left, Right) — C3 MRO puts Left before Right, so Left's override
        # must win, not Right's.
        resolver = _resolver()
        ctx = _method_ctx(resolver, "Diamond")
        sig = _first_call_sig(resolver, """
            def f(self):
                return self.base_method()
        """, MODELS_FILE, ctx)
        assert sig is not None
        assert sig.qualified_name == "models.Left.base_method"

    def test_cls_dot_call_in_classmethod(self):
        resolver = _resolver()
        ctx = MethodContext(class_name="Factory", self_param="cls", is_bound=True, method_kind=MethodKind.CLASSMETHOD)
        sig = _first_call_sig(resolver, """
            def create(cls, value):
                return cls(value)
        """, MODELS_FILE, ctx)
        assert sig is not None
        assert sig.qualified_name == "models.Factory.__init__"


# ─── Same-scope and cross-module instance tracking ────────────────────────────

class TestInstanceTracking:
    def test_same_scope_instance_call_resolves(self):
        resolver = _resolver()
        registry = resolver._get_class_registry(MODELS_FILE)
        assert "Derived" in registry
        local_var_types = {"d": (MODELS_FILE, "Derived")}
        ctx = MethodContext(class_name=None, self_param=None, is_bound=False, local_var_types=local_var_types)
        sig = _first_call_sig(resolver, """
            def use_derived(value):
                return d.derived_method()
        """, MODELS_FILE, ctx)
        assert sig is not None
        assert sig.qualified_name == "models.Derived.derived_method"

    def test_cross_module_instance_call_resolves(self):
        resolver = _resolver()
        local_var_types = {"c": (SHAPES_FILE, "Circle")}
        ctx = MethodContext(class_name=None, self_param=None, is_bound=False, local_var_types=local_var_types)
        sig = _first_call_sig(resolver, """
            def use_cross_module(radius):
                return c.area()
        """, MODELS_FILE, ctx)
        assert sig is not None
        assert sig.qualified_name == "shapes.Circle.area"

    def test_build_local_var_types_same_scope(self):
        resolver = _resolver()
        tree = ast.parse(Path(MODELS_FILE).read_text())
        func_node = next(
            n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "use_derived"
        )
        local_var_types = resolver.build_local_var_types(func_node, MODELS_FILE)
        assert local_var_types["d"] == (MODELS_FILE, "Derived")

    def test_build_local_var_types_cross_module(self):
        resolver = _resolver()
        tree = ast.parse(Path(MODELS_FILE).read_text())
        func_node = next(
            n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "use_cross_module"
        )
        local_var_types = resolver.build_local_var_types(func_node, MODELS_FILE)
        assert local_var_types["c"][1] == "Circle"
        assert Path(local_var_types["c"][0]).name == "shapes.py"


# ─── Constructor calls ─────────────────────────────────────────────────────────

class TestConstructorCall:
    def test_bare_constructor_call_resolves_to_own_init(self):
        resolver = _resolver()
        sig = _first_call_sig(resolver, """
            def make():
                return Account("alice")
        """, MODELS_FILE)
        assert sig is not None
        assert sig.qualified_name == "models.Account.__init__"

    def test_constructor_call_resolves_inherited_init(self):
        # Diamond has no __init__ of its own — must resolve through the MRO to Base.
        resolver = _resolver()
        sig = _first_call_sig(resolver, """
            def make():
                return Diamond(1)
        """, MODELS_FILE)
        assert sig is not None
        assert sig.qualified_name == "models.Base.__init__"

    def test_constructor_call_with_no_init_anywhere_stays_external(self):
        # Cat has no __init__ of its own and no base class — it uses object's
        # implicit default, with no method body to point at, so it stays external/
        # unresolvable (no CALL node) — same as any other trivial call, and unlike
        # a resolvable constructor that has a real (possibly inherited) __init__.
        resolver = _resolver()
        sig = _first_call_sig(resolver, """
            def make():
                return Cat()
        """, MODELS_FILE)
        assert sig is not None
        assert sig.is_external is True
        assert sig.is_resolvable is False

    def test_default_constructor_calls_stay_grouped_in_one_statement_node(self):
        # `cat = Cat()` and `dog = Dog()` neither resolve to a CALL node (no
        # __init__ anywhere in either class), so they group into a single
        # STATEMENT node together — each on its own line (frontend renders the
        # embedded newline as a line break, not a single run-on line).
        ctx = build_project_context(
            file_path=MODELS_FILE,
            function_name="call_both_animals",
            project_root=FIXTURE_ROOT,
            max_call_depth=1,
        )
        cfg = ctx.all_graphs[ctx.entry_qualified_name]
        statement_labels = [n.label for n in cfg.nodes if n.node_type == NodeType.STATEMENT]
        assert "cat = Cat()\ndog = Dog()" in statement_labels


# ─── Same-named methods on unrelated classes don't collide ────────────────────

class TestCollisionRegression:
    def test_cat_speak_and_dog_speak_resolve_independently(self):
        resolver = _resolver()
        cat_ctx = _method_ctx(resolver, "Cat")
        dog_ctx = _method_ctx(resolver, "Dog")
        cat_sig = _first_call_sig(resolver, """
            def f(self):
                return self.speak()
        """, MODELS_FILE, cat_ctx)
        dog_sig = _first_call_sig(resolver, """
            def f(self):
                return self.speak()
        """, MODELS_FILE, dog_ctx)
        assert cat_sig.qualified_name == "models.Cat.speak"
        assert dog_sig.qualified_name == "models.Dog.speak"


# ─── call_occurrence: disambiguating two calls sharing one source line ────────

class TestCallOccurrence:
    def test_two_calls_on_the_same_line_get_distinct_occurrence_indices(self):
        # `cat.speak() + dog.speak()` — the trace's own call sites are keyed by
        # (parent_frame_id, call_line) alone, so without call_occurrence, clicking
        # either CALL node would always resolve to whichever call happened first.
        ctx = build_project_context(
            file_path=MODELS_FILE,
            function_name="call_both_animals",
            project_root=FIXTURE_ROOT,
            max_call_depth=1,
        )
        cfg = ctx.all_graphs[ctx.entry_qualified_name]
        calls = [n for n in cfg.nodes if n.node_type == NodeType.CALL]
        by_label = {n.label: n for n in calls}
        assert by_label["→ Cat.speak()"].start_line == by_label["→ Dog.speak()"].start_line
        assert by_label["→ Cat.speak()"].call_occurrence == 0
        assert by_label["→ Dog.speak()"].call_occurrence == 1

    def test_calls_on_different_lines_both_get_occurrence_zero(self):
        ctx = build_project_context(
            file_path=MODELS_FILE,
            function_name="use_derived",
            project_root=FIXTURE_ROOT,
            max_call_depth=1,
        )
        cfg = ctx.all_graphs[ctx.entry_qualified_name]
        calls = [n for n in cfg.nodes if n.node_type == NodeType.CALL]
        assert all(n.call_occurrence == 0 for n in calls)


# ─── Recursion: a function (or two) calling itself ─────────────────────────────

class TestRecursion:
    def test_direct_recursive_call_resolves_to_a_call_node(self, tmp_path):
        # Regression test: module_functions used to exclude the function currently
        # being graphed, so a function calling *itself* could never be found — the
        # whole call stayed inline as unresolved text instead of becoming a CALL
        # node, and there was nothing to navigate into.
        src = tmp_path / "fib.py"
        src.write_text(textwrap.dedent("""
            def fibonacci_nth(n):
                if n < 2:
                    return n
                return fibonacci_nth(n - 1) + fibonacci_nth(n - 2)
        """))
        ctx = build_project_context(
            file_path=str(src), function_name="fibonacci_nth", project_root=str(tmp_path), max_call_depth=2,
        )
        cfg = ctx.all_graphs[ctx.entry_qualified_name]
        calls = [n for n in cfg.nodes if n.node_type == NodeType.CALL]
        assert [c.label for c in calls] == ["→ fibonacci_nth(n - 1)", "→ fibonacci_nth(n - 2)"]
        assert [c.call_occurrence for c in calls] == [0, 1]
        # Each recursive CALL node points back at the function's own CFG, so it's
        # navigable rather than a dead end.
        assert all(c.sub_graph is not None for c in calls)

    def test_recursive_call_inside_a_nested_function_resolves(self, tmp_path):
        src = tmp_path / "nested_fib.py"
        src.write_text(textwrap.dedent("""
            def outer():
                def helper(n):
                    if n <= 0:
                        return 0
                    return helper(n - 1)
                return helper(5)
        """))
        ctx = build_project_context(
            file_path=str(src), function_name="outer", project_root=str(tmp_path), max_call_depth=2,
        )
        outer_cfg = ctx.all_graphs[ctx.entry_qualified_name]
        outer_calls = [n.called_function for n in outer_cfg.nodes if n.called_function]
        assert outer_calls == ["nested_fib.helper"]
        helper_cfg = ctx.all_graphs["nested_fib.helper"]
        helper_calls = [n for n in helper_cfg.nodes if n.node_type == NodeType.CALL]
        assert [c.label for c in helper_calls] == ["→ helper(n - 1)"]

    def test_mutual_recursion_resolves_both_directions_without_hanging(self, tmp_path):
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
        ctx = build_project_context(
            file_path=str(src), function_name="is_even", project_root=str(tmp_path), max_call_depth=3,
        )
        even_cfg = ctx.all_graphs["mutual.is_even"]
        odd_cfg = ctx.all_graphs["mutual.is_odd"]
        assert [n.called_function for n in even_cfg.nodes if n.called_function] == ["mutual.is_odd"]
        assert [n.called_function for n in odd_cfg.nodes if n.called_function] == ["mutual.is_even"]


# ─── External / unresolvable boundary ──────────────────────────────────────────

class TestExternalBoundary:
    def test_third_party_style_import_stays_external(self, tmp_path):
        src = tmp_path / "uses_external.py"
        src.write_text(textwrap.dedent("""
            import os

            def f():
                return os.path.join("a", "b")
        """))
        resolver = CallResolver(str(tmp_path), {})
        tree = ast.parse(src.read_text())
        func_node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef))
        call_node = next(n for n in ast.walk(func_node) if isinstance(n, ast.Call))
        sig = resolver.resolve_call(call_node, str(src), {})
        assert sig is not None
        assert sig.is_external is True
        assert sig.is_resolvable is False
