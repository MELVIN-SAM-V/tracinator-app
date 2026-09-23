import ast
import textwrap

import pytest

from tracinator.analyzer.call_resolver import MethodContext
from tracinator.analyzer.cfg_builder import CFGBuilder
from tracinator.models import EdgeType, MethodKind, NodeType


def _build(source: str, func_name: str = "f") -> object:
    source = textwrap.dedent(source)
    tree = ast.parse(source)
    func_node = next(
        n for n in ast.walk(tree)
        if isinstance(n, ast.FunctionDef) and n.name == func_name
    )
    builder = CFGBuilder(
        source_file="<test>",
        source_lines=source.splitlines(),
        call_resolver=None,
    )
    return builder.build(func_node, qualified_prefix=func_name)


def _build_method(source: str, class_name: str, method_name: str, method_kind: MethodKind) -> object:
    source = textwrap.dedent(source)
    tree = ast.parse(source)
    cls_node = next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == class_name)
    func_node = next(
        n for n in cls_node.body
        if isinstance(n, ast.FunctionDef) and n.name == method_name
    )
    self_param = None
    if method_kind != MethodKind.STATICMETHOD and func_node.args.args:
        self_param = func_node.args.args[0].arg
    method_ctx = MethodContext(
        class_name=class_name,
        self_param=self_param,
        is_bound=method_kind != MethodKind.STATICMETHOD,
        method_kind=method_kind,
    )
    builder = CFGBuilder(
        source_file="<test>",
        source_lines=source.splitlines(),
        call_resolver=None,
    )
    return builder.build(
        func_node,
        qualified_prefix=f"{class_name}.{method_name}",
        function_name=f"{class_name}.{method_name}",
        method_ctx=method_ctx,
    )


def node_types(cfg) -> list[str]:
    return [n.node_type.name for n in cfg.nodes]


def edge_types(cfg) -> list[str]:
    return [e.edge_type.name for e in cfg.edges]


# ─── Basic structure ──────────────────────────────────────────────────────────

class TestSequential:
    def test_entry_exit(self):
        cfg = _build("""
            def f():
                pass
        """)
        assert NodeType.ENTRY in [n.node_type for n in cfg.nodes]
        assert cfg.entry_node_id is not None

    def test_single_statement(self):
        cfg = _build("""
            def f():
                x = 1
                y = 2
        """)
        types = node_types(cfg)
        assert "ENTRY" in types
        assert "STATEMENT" in types

    def test_explicit_return(self):
        cfg = _build("""
            def f(x):
                return x + 1
        """)
        types = node_types(cfg)
        assert "RETURN" in types
        assert "EXIT" not in types  # explicit return, no implicit exit

    def test_implicit_return(self):
        cfg = _build("""
            def f():
                x = 1
        """)
        types = node_types(cfg)
        assert "EXIT" in types  # implicit return → EXIT node

    def test_sequential_statements_grouped(self):
        cfg = _build("""
            def f():
                a = 1
                b = 2
                c = 3
                return c
        """)
        stmt_nodes = [n for n in cfg.nodes if n.node_type == NodeType.STATEMENT]
        assert len(stmt_nodes) == 1  # grouped into one node
        assert "a = 1" in stmt_nodes[0].label


# ─── Branches ─────────────────────────────────────────────────────────────────

class TestBranches:
    def test_if_no_else(self):
        cfg = _build("""
            def f(x):
                if x > 0:
                    x = x + 1
                return x
        """)
        types = node_types(cfg)
        assert "IF" in types

        if_node = next(n for n in cfg.nodes if n.node_type == NodeType.IF)
        out_edges = cfg.get_outgoing_edges(if_node.id)
        edge_type_names = {e.edge_type.name for e in out_edges}
        assert "TRUE" in edge_type_names
        assert "FALSE" in edge_type_names

    def test_if_else(self):
        cfg = _build("""
            def f(x):
                if x > 0:
                    return 1
                else:
                    return -1
        """)
        types = node_types(cfg)
        assert "IF" in types
        returns = [n for n in cfg.nodes if n.node_type == NodeType.RETURN]
        assert len(returns) == 2

    def test_if_elif_else(self):
        cfg = _build("""
            def f(x):
                if x > 0:
                    return 1
                elif x < 0:
                    return -1
                else:
                    return 0
        """)
        if_nodes = [n for n in cfg.nodes if n.node_type in (NodeType.IF, NodeType.ELIF)]
        assert len(if_nodes) == 2
        returns = [n for n in cfg.nodes if n.node_type == NodeType.RETURN]
        assert len(returns) == 3

    def test_condition_captured(self):
        cfg = _build("""
            def f(x):
                if x > 0:
                    return True
                return False
        """)
        if_node = next(n for n in cfg.nodes if n.node_type == NodeType.IF)
        assert "x > 0" in if_node.condition

    def test_nested_if(self):
        cfg = _build("""
            def f(x, y):
                if x > 0:
                    if y > 0:
                        return 1
                    return 2
                return 3
        """)
        if_nodes = [n for n in cfg.nodes if n.node_type in (NodeType.IF, NodeType.ELIF)]
        assert len(if_nodes) == 2


# ─── Loops ────────────────────────────────────────────────────────────────────

class TestLoops:
    def test_for_loop(self):
        cfg = _build("""
            def f(items):
                for item in items:
                    print(item)
        """)
        types = node_types(cfg)
        assert "FOR" in types

        for_node = next(n for n in cfg.nodes if n.node_type == NodeType.FOR)
        out_edges = cfg.get_outgoing_edges(for_node.id)
        edge_type_names = {e.edge_type.name for e in out_edges}
        assert "TRUE" in edge_type_names  # iterate
        assert "LOOP_EXIT" in edge_type_names or "FALSE" in edge_type_names  # exit

    def test_for_loop_has_loop_back(self):
        cfg = _build("""
            def f(items):
                for item in items:
                    x = item
        """)
        back_edges = [e for e in cfg.edges if e.edge_type == EdgeType.LOOP_BACK]
        assert len(back_edges) >= 1

    def test_while_loop(self):
        cfg = _build("""
            def f(n):
                while n > 0:
                    n -= 1
        """)
        types = node_types(cfg)
        assert "WHILE" in types

        while_node = next(n for n in cfg.nodes if n.node_type == NodeType.WHILE)
        assert "n > 0" in while_node.condition

    def test_while_has_loop_back(self):
        cfg = _build("""
            def f(n):
                while n > 0:
                    n -= 1
        """)
        back_edges = [e for e in cfg.edges if e.edge_type == EdgeType.LOOP_BACK]
        assert len(back_edges) >= 1

    def test_break_in_loop(self):
        cfg = _build("""
            def f(items):
                for item in items:
                    if item < 0:
                        break
                return True
        """)
        types = node_types(cfg)
        assert "BREAK" in types

    def test_continue_in_loop(self):
        cfg = _build("""
            def f(items):
                for item in items:
                    if item == 0:
                        continue
                    print(item)
        """)
        types = node_types(cfg)
        assert "CONTINUE" in types


# ─── Try/Except ───────────────────────────────────────────────────────────────

class TestTryExcept:
    def test_try_except(self):
        cfg = _build("""
            def f():
                try:
                    x = int("abc")
                except ValueError:
                    x = 0
        """)
        types = node_types(cfg)
        assert "TRY" in types
        assert "EXCEPT" in types

    def test_try_except_has_exception_edge(self):
        cfg = _build("""
            def f():
                try:
                    risky()
                except Exception:
                    pass
        """)
        try_node = next(n for n in cfg.nodes if n.node_type == NodeType.TRY)
        out_edges = cfg.get_outgoing_edges(try_node.id)
        exception_edges = [e for e in out_edges if e.edge_type == EdgeType.EXCEPTION]
        assert len(exception_edges) >= 1

    def test_try_finally(self):
        cfg = _build("""
            def f():
                try:
                    x = 1
                finally:
                    cleanup()
        """)
        types = node_types(cfg)
        assert "TRY" in types
        assert "FINALLY" in types

    def test_multiple_except(self):
        cfg = _build("""
            def f():
                try:
                    risky()
                except ValueError:
                    pass
                except TypeError:
                    pass
        """)
        except_nodes = [n for n in cfg.nodes if n.node_type == NodeType.EXCEPT]
        assert len(except_nodes) == 2


# ─── With statement ───────────────────────────────────────────────────────────

class TestWith:
    def test_with_statement(self):
        cfg = _build("""
            def f(path):
                with open(path) as f:
                    data = f.read()
                return data
        """)
        types = node_types(cfg)
        assert "WITH" in types

    def test_with_label(self):
        cfg = _build("""
            def f(path):
                with open(path) as f:
                    pass
        """)
        with_node = next(n for n in cfg.nodes if n.node_type == NodeType.WITH)
        assert "open" in with_node.label


# ─── Raise ────────────────────────────────────────────────────────────────────

class TestRaise:
    def test_raise(self):
        cfg = _build("""
            def f(x):
                if x < 0:
                    raise ValueError("negative")
                return x
        """)
        types = node_types(cfg)
        assert "RAISE" in types

    def test_raise_is_exit_node(self):
        cfg = _build("""
            def f(x):
                if x < 0:
                    raise ValueError("negative")
                return x
        """)
        raise_nodes = [n for n in cfg.nodes if n.node_type == NodeType.RAISE]
        assert len(raise_nodes) == 1
        assert raise_nodes[0].id in cfg.exit_node_ids


# ─── Graph structure ──────────────────────────────────────────────────────────

class TestGraphStructure:
    def test_entry_node_has_no_incoming(self):
        cfg = _build("""
            def f(x):
                return x
        """)
        incoming = cfg.get_incoming_edges(cfg.entry_node_id)
        assert len(incoming) == 0

    def test_exit_nodes_have_no_outgoing(self):
        cfg = _build("""
            def f(x):
                if x:
                    return 1
                return 0
        """)
        for exit_id in cfg.exit_node_ids:
            outgoing = cfg.get_outgoing_edges(exit_id)
            forward = [e for e in outgoing if e.edge_type != EdgeType.LOOP_BACK]
            assert len(forward) == 0

    def test_all_paths_simple(self):
        cfg = _build("""
            def f(x):
                return x
        """)
        paths = cfg.all_paths()
        assert len(paths) == 1
        assert paths[0][0] == cfg.entry_node_id

    def test_all_paths_branch(self):
        cfg = _build("""
            def f(x):
                if x > 0:
                    return 1
                return 0
        """)
        paths = cfg.all_paths()
        assert len(paths) == 2

    def test_node_ids_unique(self):
        cfg = _build("""
            def f(x):
                if x > 0:
                    if x > 10:
                        return 2
                    return 1
                return 0
        """)
        ids = [n.id for n in cfg.nodes]
        assert len(ids) == len(set(ids))


# ─── Method ENTRY labels: self/cls stripped by position, not by name ─────────

class TestMethodEntryLabel:
    def test_instance_method_strips_self(self):
        cfg = _build_method("""
            class Foo:
                def bar(self, x, y):
                    return x + y
        """, "Foo", "bar", MethodKind.INSTANCE)
        entry = next(n for n in cfg.nodes if n.node_type == NodeType.ENTRY)
        assert entry.label == "bar(x, y)"

    def test_instance_method_strips_renamed_first_param(self):
        # Stripping is positional, not name-based — must work even when the
        # first param isn't literally called "self".
        cfg = _build_method("""
            class Foo:
                def bar(this, x):
                    return x
        """, "Foo", "bar", MethodKind.INSTANCE)
        entry = next(n for n in cfg.nodes if n.node_type == NodeType.ENTRY)
        assert entry.label == "bar(x)"

    def test_classmethod_strips_cls(self):
        cfg = _build_method("""
            class Foo:
                @classmethod
                def make(cls, x):
                    return cls(x)
        """, "Foo", "make", MethodKind.CLASSMETHOD)
        entry = next(n for n in cfg.nodes if n.node_type == NodeType.ENTRY)
        assert entry.label == "make(x)"

    def test_staticmethod_keeps_all_params(self):
        cfg = _build_method("""
            class Foo:
                @staticmethod
                def double(n):
                    return n * 2
        """, "Foo", "double", MethodKind.STATICMETHOD)
        entry = next(n for n in cfg.nodes if n.node_type == NodeType.ENTRY)
        assert entry.label == "double(n)"

    def test_control_flow_graph_function_name_is_dotted(self):
        cfg = _build_method("""
            class Foo:
                def bar(self):
                    pass
        """, "Foo", "bar", MethodKind.INSTANCE)
        assert cfg.function_name == "Foo.bar"
