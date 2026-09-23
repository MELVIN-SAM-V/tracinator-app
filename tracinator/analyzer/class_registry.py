from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Callable, Iterator

from tracinator.models import MethodKind


@dataclass
class DefEntry:
    """One function or method definition found by `iter_defs`."""
    ast_node: ast.FunctionDef | ast.AsyncFunctionDef
    name: str                      # bare, e.g. "bar"
    qualified_name: str            # "Foo.bar" for methods, bare "bar" for plain/nested functions
    class_name: str | None         # dotted enclosing class, e.g. "Outer.Inner"; None for plain functions
    method_kind: MethodKind | None # set only when class_name is set


@dataclass
class MethodInfo:
    ast_node: ast.FunctionDef | ast.AsyncFunctionDef
    name: str                    # bare, e.g. "bar"
    qualified_name: str          # class-relative dotted, e.g. "Foo.bar"
    class_name: str              # dotted, e.g. "Foo" or "Outer.Inner"
    method_kind: MethodKind


@dataclass
class ClassInfo:
    ast_node: ast.ClassDef
    qualified_name: str          # dotted, e.g. "Outer.Inner"
    base_names: list[str]        # raw base expressions, e.g. ["Base"], ["pkg.mod.Base"]
    methods: dict[str, MethodInfo] = field(default_factory=dict)
    source_file: str = ""


def _detect_method_kind(fn_node: ast.FunctionDef | ast.AsyncFunctionDef) -> MethodKind:
    """Decorator-only detection — correct even if the codebase renames self/cls."""
    decorator_names: set[str] = set()
    for dec in fn_node.decorator_list:
        if isinstance(dec, ast.Name):
            decorator_names.add(dec.id)
        elif isinstance(dec, ast.Attribute):
            decorator_names.add(dec.attr)
    if "staticmethod" in decorator_names:
        return MethodKind.STATICMETHOD
    if "classmethod" in decorator_names:
        return MethodKind.CLASSMETHOD
    return MethodKind.INSTANCE


def _nested_stmt_lists(stmt: ast.stmt) -> list[list[ast.stmt]]:
    """Statement lists to descend into so defs nested inside control flow (if/for/
    while/try/with/match) at module or function top level are still found — mirrors
    ast.walk's completeness for these containers, without descending into class
    bodies (those are handled explicitly, direct-children only)."""
    lists: list[list[ast.stmt]] = []
    if isinstance(stmt, ast.If):
        lists.append(stmt.body)
        lists.append(stmt.orelse)
    elif isinstance(stmt, (ast.For, ast.AsyncFor, ast.While)):
        lists.append(stmt.body)
        lists.append(stmt.orelse)
    elif isinstance(stmt, ast.Try):
        lists.append(stmt.body)
        for handler in stmt.handlers:
            lists.append(handler.body)
        lists.append(stmt.orelse)
        lists.append(stmt.finalbody)
    elif hasattr(ast, "TryStar") and isinstance(stmt, ast.TryStar):
        lists.append(stmt.body)
        for handler in stmt.handlers:
            lists.append(handler.body)
        lists.append(stmt.orelse)
        lists.append(stmt.finalbody)
    elif isinstance(stmt, (ast.With, ast.AsyncWith)):
        lists.append(stmt.body)
    elif hasattr(ast, "Match") and isinstance(stmt, ast.Match):
        for case in stmt.cases:
            lists.append(case.body)
    return lists


def iter_defs(container: ast.Module | ast.FunctionDef | ast.AsyncFunctionDef) -> Iterator[DefEntry]:
    """Recursive visitor (not ast.walk, which loses nesting) over a module or a
    single function's body. Descends into ast.ClassDef, pushing onto a class-name
    stack, and yields a DefEntry for every direct-child method plus every nested
    class's direct-child methods. A method's own body subtree is NOT treated as
    "inside a class" for its nested closures — matches today's local-function
    semantics for functions nested inside a method."""
    yield from _walk_body(container.body, class_stack=[])


def _walk_body(stmts: list[ast.stmt], class_stack: list[str]) -> Iterator[DefEntry]:
    for stmt in stmts:
        if isinstance(stmt, ast.ClassDef):
            yield from _walk_class_body(stmt, class_stack + [stmt.name])
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield DefEntry(
                ast_node=stmt,
                name=stmt.name,
                qualified_name=stmt.name,
                class_name=None,
                method_kind=None,
            )
            yield from _walk_body(stmt.body, [])
        else:
            for nested in _nested_stmt_lists(stmt):
                yield from _walk_body(nested, class_stack)


def _walk_class_body(cls_node: ast.ClassDef, class_stack: list[str]) -> Iterator[DefEntry]:
    class_name = ".".join(class_stack)
    for stmt in cls_node.body:
        if isinstance(stmt, ast.ClassDef):
            yield from _walk_class_body(stmt, class_stack + [stmt.name])
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield DefEntry(
                ast_node=stmt,
                name=stmt.name,
                qualified_name=f"{class_name}.{stmt.name}",
                class_name=class_name,
                method_kind=_detect_method_kind(stmt),
            )
            # The method's own body is not "inside a class" for its nested closures.
            yield from _walk_body(stmt.body, [])


def build_class_registry(tree: ast.Module, source_file: str) -> dict[str, ClassInfo]:
    """All classes declared in `tree`, keyed by dotted qualified_name (e.g. "Outer.Inner")."""
    registry: dict[str, ClassInfo] = {}

    def visit_class(cls_node: ast.ClassDef, class_stack: list[str]) -> None:
        qualified = ".".join(class_stack)
        info = ClassInfo(
            ast_node=cls_node,
            qualified_name=qualified,
            base_names=[ast.unparse(b) for b in cls_node.bases],
            source_file=source_file,
        )
        registry[qualified] = info
        for stmt in cls_node.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                info.methods[stmt.name] = MethodInfo(
                    ast_node=stmt,
                    name=stmt.name,
                    qualified_name=f"{qualified}.{stmt.name}",
                    class_name=qualified,
                    method_kind=_detect_method_kind(stmt),
                )
            elif isinstance(stmt, ast.ClassDef):
                visit_class(stmt, class_stack + [stmt.name])

    def visit_body(stmts: list[ast.stmt], class_stack: list[str]) -> None:
        for stmt in stmts:
            if isinstance(stmt, ast.ClassDef):
                visit_class(stmt, class_stack + [stmt.name])
            elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                visit_body(stmt.body, [])
            else:
                for nested in _nested_stmt_lists(stmt):
                    visit_body(nested, class_stack)

    visit_body(tree.body, [])
    return registry


def display_params(parameters: list[str], method_kind: MethodKind | None) -> list[str]:
    """Strip the leading self/cls param for instance/classmethods (by position, not
    by literal name — works even if a codebase renames it). Staticmethods and plain
    functions keep every declared parameter."""
    if method_kind in (MethodKind.INSTANCE, MethodKind.CLASSMETHOD) and parameters:
        return parameters[1:]
    return parameters


def _c3_merge(sequences: list[list[tuple[str, str]]]) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    seqs = [list(seq) for seq in sequences if seq]
    while seqs:
        candidate = None
        for seq in seqs:
            head = seq[0]
            if not any(head in s[1:] for s in seqs):
                candidate = head
                break
        if candidate is None:
            # Inconsistent hierarchy — fall back to a stable pick rather than raising;
            # this is a best-effort static approximation of a runtime property.
            candidate = seqs[0][0]
        result.append(candidate)
        for s in seqs:
            if s and s[0] == candidate:
                del s[0]
        seqs = [s for s in seqs if s]
    return result


def resolve_mro(
    start_file: str,
    class_name: str,
    load_registry: Callable[[str], dict[str, ClassInfo]],
    resolve_base: Callable[[str, dict[str, ClassInfo], str], tuple[str, str] | None],
) -> list[tuple[str, str]]:
    """Real C3 linearization ("L[C] = C + merge(L[B1], L[B2], ..., [B1, B2, ...])")
    of `class_name` (declared in `start_file`), returned as a most-derived-first list
    of (file_path, class_name) pairs.

    `load_registry(file_path)` lazily loads/caches that file's class registry (the
    same lazy-parse-and-cache pattern used elsewhere).
    `resolve_base(file_path, registry, base_expr)` resolves one raw base-class
    expression (e.g. "Base" or "pkg.mod.Base") to the (file_path, class_name) it
    refers to, or None if it can't be resolved to a project-local class (external/
    third-party base, or `object`) — that terminates that branch of the
    linearization, consistent with the external-package boundary elsewhere.
    """

    def linearize(file_path: str, cname: str) -> list[tuple[str, str]]:
        registry = load_registry(file_path)
        info = registry.get(cname)
        if info is None:
            return [(file_path, cname)]

        base_linearizations: list[list[tuple[str, str]]] = []
        base_order: list[tuple[str, str]] = []
        for base_expr in info.base_names:
            resolved = resolve_base(file_path, registry, base_expr)
            if resolved is None:
                continue
            base_file, base_cname = resolved
            base_linearizations.append(linearize(base_file, base_cname))
            base_order.append((base_file, base_cname))

        merged = _c3_merge(base_linearizations + [base_order])
        return [(file_path, cname)] + merged

    return linearize(start_file, class_name)
