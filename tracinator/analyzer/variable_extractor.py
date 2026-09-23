import ast
import builtins
from collections import defaultdict

from tracinator.models import VariableInfo, VariableScope

_BUILTIN_NAMES = frozenset(dir(builtins))


def extract_variables(
    function_node: ast.FunctionDef,
    source_file: str,
) -> list[VariableInfo]:
    collector = _VariableCollector()
    collector.visit(function_node)
    return collector.build_variables()


class _VariableCollector(ast.NodeVisitor):
    def __init__(self) -> None:
        self.params: list[str] = []
        self.globals: set[str] = set()
        self.assigned_lines: dict[str, list[int]] = defaultdict(list)
        self.read_lines: dict[str, list[int]] = defaultdict(list)
        self.type_hints: dict[str, str] = {}
        # {name: {line: expr}} — all assignments across all lines
        self.all_assignment_exprs: dict[str, dict[int, str]] = defaultdict(dict)
        self.callee_names: set[str] = set()
        self._in_function = False

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        if not self._in_function:
            self._in_function = True
            # `node.args.args` alone misses positional-only params (their own
            # `posonlyargs` list) and keyword-only params — anything after a bare
            # `*` — which live in `kwonlyargs`, not `args`. Without these, a
            # keyword-only param reads as an undeclared name for the rest of this
            # function: never "assigned" at entry, so it shows up as a free/global
            # read instead of a bound parameter.
            declared_args = (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs)
            self.params = [arg.arg for arg in declared_args]
            for arg in declared_args:
                self.assigned_lines[arg.arg].append(node.lineno)
                if arg.annotation:
                    self.type_hints[arg.arg] = ast.unparse(arg.annotation)
            # Visit body only — generic_visit would also walk annotations and
            # the return type, causing type names like `str` to appear as reads.
            for stmt in node.body:
                self.visit(stmt)

    def visit_Global(self, node: ast.Global) -> None:
        for name in node.names:
            self.globals.add(name)

    def visit_Assign(self, node: ast.Assign) -> None:
        expr = _truncate(ast.unparse(node.value))
        for target in node.targets:
            for name in _extract_names(target):
                self.assigned_lines[name].append(node.lineno)
                self.all_assignment_exprs[name][node.lineno] = expr
        self._visit_value(node.value, node.lineno)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if isinstance(node.target, ast.Name):
            name = node.target.id
            self.assigned_lines[name].append(node.lineno)
            if node.annotation:
                self.type_hints[name] = ast.unparse(node.annotation)
            if node.value:
                expr = _truncate(ast.unparse(node.value))
                self.all_assignment_exprs[name][node.lineno] = expr
                self._visit_value(node.value, node.lineno)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        if isinstance(node.target, ast.Name):
            name = node.target.id
            self.assigned_lines[name].append(node.lineno)
            self.read_lines[name].append(node.lineno)
            # e.g. count += 1  →  "count + 1"
            try:
                op_node = ast.BinOp(
                    left=ast.Name(id=name, ctx=ast.Load()),
                    op=node.op,
                    right=node.value,
                )
                expr = _truncate(ast.unparse(op_node))
            except Exception:
                expr = f"{name} (augmented)"
            self.all_assignment_exprs[name][node.lineno] = expr

    def visit_Call(self, node: ast.Call) -> None:
        if isinstance(node.func, ast.Name):
            self.callee_names.add(node.func.id)
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load):
            self.read_lines[node.id].append(node.lineno)

    def _visit_value(self, value: ast.expr, lineno: int) -> None:
        for child in ast.walk(value):
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load):
                self.read_lines[child.id].append(child.lineno or lineno)

    def build_variables(self) -> list[VariableInfo]:
        all_names = set(self.assigned_lines.keys()) | set(self.read_lines.keys())
        result: list[VariableInfo] = []

        for name in sorted(all_names):
            assigned = sorted(set(self.assigned_lines.get(name, [])))
            read = sorted(set(self.read_lines.get(name, [])))
            all_lines = set(assigned + read)

            if not assigned and name not in self.params:
                if name in self.callee_names or name in _BUILTIN_NAMES:
                    continue

            if name in self.globals:
                scope = VariableScope.GLOBAL
            else:
                scope = VariableScope.STATE

            exprs = self.all_assignment_exprs.get(name, {})
            first_line = min(exprs.keys()) if exprs else None
            initial_value = exprs[first_line] if first_line is not None else None
            param_index = self.params.index(name) if name in self.params else None

            result.append(VariableInfo(
                name=name,
                scope=scope,
                inferred_type=self.type_hints.get(name),
                assigned_at_lines=assigned,
                read_at_lines=read,
                is_parameter=name in self.params,
                initial_value=initial_value,
                param_index=param_index,
                assignment_exprs=exprs,
            ))

        return result


def _extract_names(node: ast.expr) -> list[str]:
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, (ast.Tuple, ast.List)):
        names: list[str] = []
        for elt in node.elts:
            names.extend(_extract_names(elt))
        return names
    return []



def _truncate(s: str, max_len: int = 40) -> str:
    return s if len(s) <= max_len else s[:max_len - 1] + "…"
