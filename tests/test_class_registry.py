from __future__ import annotations

import ast
import textwrap

import pytest

from tracinator.analyzer.class_registry import (
    build_class_registry,
    display_params,
    iter_defs,
    resolve_mro,
)
from tracinator.analyzer.parser import find_function
from tracinator.models import MethodKind


def _tree(source: str) -> ast.Module:
    return ast.parse(textwrap.dedent(source))


# ─── iter_defs: dotted naming / nesting ───────────────────────────────────────

class TestIterDefs:
    def test_plain_function_stays_bare(self):
        entries = list(iter_defs(_tree("""
            def helper():
                pass
        """)))
        assert [e.qualified_name for e in entries] == ["helper"]
        assert entries[0].class_name is None
        assert entries[0].method_kind is None

    def test_method_gets_dotted_qualified_name(self):
        entries = list(iter_defs(_tree("""
            class Foo:
                def bar(self):
                    pass
        """)))
        assert [e.qualified_name for e in entries] == ["Foo.bar"]
        assert entries[0].class_name == "Foo"
        assert entries[0].name == "bar"

    def test_nested_class_dotted_qualified_name(self):
        entries = list(iter_defs(_tree("""
            class Outer:
                class Inner:
                    def method(self):
                        pass
        """)))
        assert [e.qualified_name for e in entries] == ["Outer.Inner.method"]
        assert entries[0].class_name == "Outer.Inner"

    def test_same_named_method_on_two_classes_does_not_collide(self):
        entries = list(iter_defs(_tree("""
            class Cat:
                def speak(self):
                    pass

            class Dog:
                def speak(self):
                    pass
        """)))
        qualified = sorted(e.qualified_name for e in entries)
        assert qualified == ["Cat.speak", "Dog.speak"]

    def test_closure_nested_inside_method_is_not_a_method(self):
        entries = list(iter_defs(_tree("""
            class Foo:
                def bar(self):
                    def helper():
                        pass
                    return helper()
        """)))
        by_name = {e.qualified_name: e for e in entries}
        assert "Foo.bar" in by_name
        assert "helper" in by_name  # bare, not "Foo.bar.helper" or "Foo.helper"
        assert by_name["helper"].class_name is None

    def test_function_nested_inside_if_is_still_found(self):
        entries = list(iter_defs(_tree("""
            if True:
                def helper():
                    pass
        """)))
        assert [e.qualified_name for e in entries] == ["helper"]

    def test_local_funcs_scoped_to_single_function_body(self):
        tree = _tree("""
            def outer():
                def inner():
                    pass
                return inner()

            def other():
                pass
        """)
        outer_node = next(
            n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "outer"
        )
        entries = list(iter_defs(outer_node))
        assert [e.qualified_name for e in entries] == ["inner"]


# ─── method_kind: decorator-based, not name-based ─────────────────────────────

class TestMethodKindDetection:
    def test_instance_method_default(self):
        entries = list(iter_defs(_tree("""
            class Foo:
                def bar(self):
                    pass
        """)))
        assert entries[0].method_kind == MethodKind.INSTANCE

    def test_classmethod_detected_by_decorator(self):
        entries = list(iter_defs(_tree("""
            class Foo:
                @classmethod
                def bar(cls):
                    pass
        """)))
        assert entries[0].method_kind == MethodKind.CLASSMETHOD

    def test_staticmethod_detected_by_decorator(self):
        entries = list(iter_defs(_tree("""
            class Foo:
                @staticmethod
                def bar(x):
                    pass
        """)))
        assert entries[0].method_kind == MethodKind.STATICMETHOD

    def test_renamed_first_param_still_detected_as_instance(self):
        # Detection is positional/decorator-based, never by the literal name "self".
        entries = list(iter_defs(_tree("""
            class Foo:
                def bar(this):
                    pass
        """)))
        assert entries[0].method_kind == MethodKind.INSTANCE


# ─── display_params ────────────────────────────────────────────────────────────

class TestDisplayParams:
    def test_instance_strips_first_param(self):
        assert display_params(["self", "x", "y"], MethodKind.INSTANCE) == ["x", "y"]

    def test_classmethod_strips_first_param(self):
        assert display_params(["cls", "x"], MethodKind.CLASSMETHOD) == ["x"]

    def test_staticmethod_keeps_all_params(self):
        assert display_params(["x", "y"], MethodKind.STATICMETHOD) == ["x", "y"]

    def test_plain_function_keeps_all_params(self):
        assert display_params(["x", "y"], None) == ["x", "y"]

    def test_no_params_is_safe(self):
        assert display_params([], MethodKind.INSTANCE) == []


# ─── build_class_registry ──────────────────────────────────────────────────────

class TestBuildClassRegistry:
    def test_base_names_captured(self):
        registry = build_class_registry(_tree("""
            class Base:
                pass

            class Derived(Base):
                pass
        """), source_file="<test>")
        assert registry["Derived"].base_names == ["Base"]

    def test_class_with_no_methods_still_registered(self):
        registry = build_class_registry(_tree("""
            class Empty:
                pass
        """), source_file="<test>")
        assert "Empty" in registry
        assert registry["Empty"].methods == {}


# ─── resolve_mro: real C3 linearization ────────────────────────────────────────

def _same_file_registries(source: str):
    registry = build_class_registry(_tree(source), source_file="f.py")

    def load_registry(_file_path):
        return registry

    def resolve_base(_file_path, reg, base_expr):
        if base_expr in reg:
            return ("f.py", base_expr)
        return None

    return load_registry, resolve_base


class TestResolveMro:
    def test_single_inheritance_chain(self):
        load_registry, resolve_base = _same_file_registries("""
            class A: pass
            class B(A): pass
            class C(B): pass
        """)
        chain = resolve_mro("f.py", "C", load_registry, resolve_base)
        assert [c for _, c in chain] == ["C", "B", "A"]

    def test_diamond_inheritance_c3_order(self):
        # Diamond: D(B, C), B(A), C(A) — C3 MRO is D, B, C, A, not naive DFS
        # (which would produce D, B, A, C).
        load_registry, resolve_base = _same_file_registries("""
            class A: pass
            class B(A): pass
            class C(A): pass
            class D(B, C): pass
        """)
        chain = resolve_mro("f.py", "D", load_registry, resolve_base)
        assert [c for _, c in chain] == ["D", "B", "C", "A"]

    def test_no_bases_returns_just_itself(self):
        load_registry, resolve_base = _same_file_registries("""
            class Solo: pass
        """)
        chain = resolve_mro("f.py", "Solo", load_registry, resolve_base)
        assert chain == [("f.py", "Solo")]

    def test_unresolvable_base_terminates_branch(self):
        # Inherits from an external/third-party class — resolve_base returns None,
        # linearization simply stops at the local class instead of raising.
        load_registry, resolve_base = _same_file_registries("""
            class Local(SomeExternalBase): pass
        """)
        chain = resolve_mro("f.py", "Local", load_registry, resolve_base)
        assert [c for _, c in chain] == ["Local"]


# ─── parser.find_function: dotted resolution + collision policy ──────────────

class TestFindFunctionCollisionPolicy:
    def test_dotted_exact_match(self):
        tree = _tree("""
            class Foo:
                def bar(self):
                    pass
        """)
        node = find_function(tree, "Foo.bar", "<test>")
        assert node.name == "bar"

    def test_bare_name_unique_across_file_resolves(self):
        tree = _tree("""
            class Foo:
                def bar(self):
                    pass

            def other():
                pass
        """)
        node = find_function(tree, "bar", "<test>")
        assert node.name == "bar"

    def test_bare_name_ambiguous_across_classes_raises(self):
        tree = _tree("""
            class Cat:
                def speak(self):
                    pass

            class Dog:
                def speak(self):
                    pass
        """)
        with pytest.raises(ValueError, match="ambiguous"):
            find_function(tree, "speak", "<test>")

    def test_unknown_name_raises_with_available_list(self):
        tree = _tree("""
            def helper():
                pass
        """)
        with pytest.raises(ValueError, match="not found"):
            find_function(tree, "nope", "<test>")
