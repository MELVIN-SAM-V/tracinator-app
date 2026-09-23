from __future__ import annotations

import ast
import textwrap

from tracinator.analyzer.class_registry import build_class_registry, iter_defs
from tracinator.server.function_listing import find_init_same_file, function_item


def _tree(source: str) -> ast.Module:
    return ast.parse(textwrap.dedent(source))


def _items(source: str) -> list[dict]:
    tree = _tree(source)
    registry = build_class_registry(tree, source_file="<test>")
    return [
        function_item(entry, lambda cn: find_init_same_file(registry, cn))
        for entry in iter_defs(tree)
    ]


# ─── function_item: args ─────────────────────────────────────────────────────
# Regression: `entry.ast_node.args.args` alone only covers regular
# positional-or-keyword parameters — it silently drops keyword-only params
# (anything after a bare `*`) and positional-only ones (anything before `/`),
# which used to make the trace-args form ask for far fewer values than a
# function actually takes. Reproduces the real report: tracinator/tracer/
# capture.py's `capture_value(value, *, depth=0, seen=None)` only prompted for
# `value`.

class TestFunctionItemArgs:
    def test_keyword_only_params_are_included(self):
        items = _items("""
            def capture_value(value, *, depth=0, seen=None):
                pass
        """)
        assert items[0]["args"] == ["value", "depth", "seen"]

    def test_positional_only_params_are_included(self):
        items = _items("""
            def add(a, b, /, c):
                pass
        """)
        assert items[0]["args"] == ["a", "b", "c"]

    def test_plain_function_unaffected(self):
        items = _items("""
            def greet(name):
                pass
        """)
        assert items[0]["args"] == ["name"]

    def test_constructor_args_include_keyword_only_params(self):
        items = _items("""
            class Box:
                def __init__(self, size, *, label=""):
                    pass

                def describe(self):
                    pass
        """)
        describe = next(i for i in items if i["name"] == "describe")
        assert describe["constructor_args"] == ["size", "label"]
