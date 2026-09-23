from __future__ import annotations

import ast
import textwrap

from tracinator.analyzer.variable_extractor import extract_variables


def _function(source: str) -> ast.FunctionDef:
    tree = ast.parse(textwrap.dedent(source))
    return tree.body[0]


# ─── extract_variables: parameter recognition ────────────────────────────────
# Regression: `node.args.args` alone misses keyword-only params (anything
# after a bare `*`) and positional-only ones (anything before `/`) — without
# them, such a parameter reads as an undeclared name for the rest of the
# function (never "assigned" at entry), so it shows up as a free/global read
# in the graph instead of a bound parameter. Reproduces the real report:
# tracinator/tracer/capture.py's `capture_value(value, *, depth=0, seen=None)`.

class TestExtractVariablesParams:
    def test_keyword_only_params_are_recognized_as_params(self):
        node = _function("""
            def capture_value(value, *, depth=0, seen=None):
                return depth
        """)
        variables = {v.name: v for v in extract_variables(node, "<test>")}
        assert set(variables) == {"value", "depth", "seen"}
        assert all(v.is_parameter for v in variables.values())
        # param_index reflects declaration order (positional-only, then
        # regular, then keyword-only) — used elsewhere to line up a param
        # with the UI-collected value at the same position.
        assert [variables[n].param_index for n in ("value", "depth", "seen")] == [0, 1, 2]

    def test_positional_only_params_are_recognized_as_params(self):
        node = _function("""
            def add(a, b, /, c):
                return a + b + c
        """)
        variables = {v.name: v for v in extract_variables(node, "<test>")}
        assert set(variables) == {"a", "b", "c"}
        assert all(v.is_parameter for v in variables.values())

    def test_keyword_only_param_type_hint_is_captured(self):
        node = _function("""
            def f(*, seen: int = 0):
                return seen
        """)
        variables = extract_variables(node, "<test>")
        seen = next(v for v in variables if v.name == "seen")
        assert seen.inferred_type == "int"
