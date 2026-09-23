import ast
from dataclasses import dataclass, field
from pathlib import Path

from tracinator.analyzer.class_registry import (
    ClassInfo,
    DefEntry,
    MethodInfo,
    build_class_registry,
    iter_defs,
    resolve_mro,
)
from tracinator.analyzer.import_resolver import ImportResolver
from tracinator.analyzer.parser import parse_file
from tracinator.models import FunctionSignature, ImportResolution, MethodKind


PYTHON_BUILTINS = frozenset({
    "print", "len", "range", "enumerate", "zip", "map", "filter", "sorted",
    "list", "dict", "set", "tuple", "str", "int", "float", "bool", "bytes",
    "type", "isinstance", "issubclass", "hasattr", "getattr", "setattr",
    "delattr", "callable", "iter", "next", "open", "input", "abs", "max",
    "min", "sum", "round", "pow", "hash", "id", "hex", "oct", "bin", "chr",
    "ord", "repr", "vars", "dir", "help", "super", "object", "property",
    "staticmethod", "classmethod", "any", "all", "reversed", "format",
})


@dataclass
class MethodContext:
    class_name: str | None                                  # dotted class owning the function being analyzed
    self_param: str | None                                   # actual first-arg name, may not be "self"/"cls"
    is_bound: bool                                            # False for @staticmethod / plain functions
    method_kind: MethodKind | None = None                     # drives display_params (ENTRY label stripping)
    # var name -> (file_path, class qualified_name) it was last assigned from — flow-
    # insensitive, same-scope, cross-file OK.
    local_var_types: dict[str, tuple[str, str]] = field(default_factory=dict)


class CallResolver:
    def __init__(self, project_root: str, import_map: dict[str, ImportResolution]) -> None:
        self.project_root = Path(project_root).resolve()
        self.import_map = import_map
        self._signature_cache: dict[str, FunctionSignature] = {}
        self._class_registry_cache: dict[str, dict[str, ClassInfo]] = {}
        self._import_map_cache: dict[str, dict[str, ImportResolution]] = {}
        self._import_resolver = ImportResolver(str(self.project_root))

    def resolve_call(
        self,
        call_node: ast.Call,
        current_file: str,
        local_functions: dict[str, DefEntry],
        method_ctx: MethodContext | None = None,
    ) -> FunctionSignature | None:
        name = self._extract_call_name(call_node)
        if name is None:
            return None

        root_name = name.split(".")[0]
        method_name = name.split(".")[-1]

        # 1. Builtins
        if root_name in PYTHON_BUILTINS:
            return FunctionSignature(
                name=name,
                qualified_name=name,
                source_file="<builtins>",
                start_line=0,
                parameters=[],
                is_external=True,
                is_resolvable=False,
            )

        # 2. self.method() / cls.method() — resolved by position, not by literal name.
        if method_ctx and method_ctx.self_param and method_ctx.class_name and root_name == method_ctx.self_param:
            found = self.find_method_via_mro(current_file, method_ctx.class_name, method_name)
            if found:
                found_file, method_info = found
                return self._signature_for_method(found_file, method_info)

        # 3. instance.method() where `instance` was assigned from a known class.
        if method_ctx and root_name in method_ctx.local_var_types:
            var_file, var_class = method_ctx.local_var_types[root_name]
            found = self.find_method_via_mro(var_file, var_class, method_name)
            if found:
                found_file, method_info = found
                return self._signature_for_method(found_file, method_info)

        # 4. Constructor call: ClassName(...) / mod.ClassName(...) resolving to that
        # class's own __init__ (walking the MRO so an inherited __init__ resolves
        # correctly too) — same-file and imported classes both handled via
        # _resolve_base_class. cls(...) inside a classmethod is the same thing —
        # for static analysis purposes cls always refers to the owning class.
        registry = self._get_class_registry(current_file)
        if (
            method_ctx
            and method_ctx.method_kind == MethodKind.CLASSMETHOD
            and method_ctx.class_name
            and name == method_ctx.self_param
        ):
            class_ref = (current_file, method_ctx.class_name)
        else:
            class_ref = self._resolve_base_class(current_file, registry, name)
        if class_ref:
            class_file, class_name = class_ref
            found = self.find_method_via_mro(class_file, class_name, "__init__")
            if found:
                found_file, method_info = found
                return self._signature_for_method(found_file, method_info)
            # No explicit __init__ anywhere in the MRO — the class uses the implicit
            # default from `object`, with no method body to point at. Treated as
            # external/unresolvable so it doesn't get its own CALL node — it stays
            # part of its statement's plain text, same as any other trivial call.
            return FunctionSignature(
                name=name,
                qualified_name=f"{self._module_prefix(class_file)}.{class_name}",
                source_file=class_file,
                start_line=self._get_class_registry(class_file)[class_name].ast_node.lineno,
                parameters=[],
                is_external=True,
                is_resolvable=False,
            )

        # 5. Local function/method in current file (dotted-qualified for methods,
        # bare for plain/nested functions — sourced from iter_defs).
        if name in local_functions:
            entry = local_functions[name]
            return FunctionSignature(
                name=entry.qualified_name,
                qualified_name=f"{self._module_prefix(current_file)}.{entry.qualified_name}",
                source_file=current_file,
                start_line=entry.ast_node.lineno,
                parameters=self._extract_params(entry.ast_node),
                is_external=False,
                is_resolvable=True,
                class_name=entry.class_name,
                method_kind=entry.method_kind,
            )

        # 6. Resolve through imports
        resolved = self._resolve_via_imports(name, current_file)
        if resolved:
            return resolved

        # 7. Cannot resolve — treat as external
        return FunctionSignature(
            name=name,
            qualified_name=name,
            source_file="<unknown>",
            start_line=0,
            parameters=[],
            is_external=True,
            is_resolvable=False,
        )

    def find_function_in_file(self, file_path: str, func_name: str) -> ast.FunctionDef | None:
        try:
            tree, _ = parse_file(file_path)
        except (FileNotFoundError, SyntaxError):
            return None
        for entry in iter_defs(tree):
            if entry.qualified_name == func_name:
                return entry.ast_node
        return None

    def build_local_var_types(
        self, func_node: ast.FunctionDef | ast.AsyncFunctionDef, current_file: str
    ) -> dict[str, tuple[str, str]]:
        """Flow-insensitive, last-assignment-wins scan of `func_node`'s top-level
        statements for `x = SomeClass(...)` / `x = mod.SomeClass(...)` — this is what
        makes `x = othermodule.Foo(); x.bar()` resolvable."""
        result: dict[str, tuple[str, str]] = {}
        registry = self._get_class_registry(current_file)
        for stmt in func_node.body:
            if not isinstance(stmt, ast.Assign):
                continue
            if len(stmt.targets) != 1 or not isinstance(stmt.targets[0], ast.Name):
                continue
            if not isinstance(stmt.value, ast.Call):
                continue
            call_target = stmt.value.func
            if not isinstance(call_target, (ast.Name, ast.Attribute)):
                continue
            try:
                expr = ast.unparse(call_target)
            except Exception:
                continue
            # Handles both a bare imported name ("from mod import Foo; Foo()") and a
            # module-attribute access ("import mod; mod.Foo()") — same-file classes
            # are checked first inside _resolve_base_class.
            resolved = self._resolve_base_class(current_file, registry, expr)
            if resolved:
                result[stmt.targets[0].id] = resolved
        return result

    # -------------------------------------------------------------------------
    # Class registry / MRO plumbing
    # -------------------------------------------------------------------------

    def _get_class_registry(self, file_path: str) -> dict[str, ClassInfo]:
        file_path = str(Path(file_path).resolve())
        if file_path not in self._class_registry_cache:
            try:
                tree, _ = parse_file(file_path)
            except (FileNotFoundError, SyntaxError):
                self._class_registry_cache[file_path] = {}
            else:
                self._class_registry_cache[file_path] = build_class_registry(tree, file_path)
        return self._class_registry_cache[file_path]

    def _get_import_map(self, file_path: str) -> dict[str, ImportResolution]:
        file_path = str(Path(file_path).resolve())
        if file_path not in self._import_map_cache:
            try:
                tree, _ = parse_file(file_path)
            except (FileNotFoundError, SyntaxError):
                self._import_map_cache[file_path] = {}
            else:
                resolutions = self._import_resolver.resolve_imports(tree, file_path)
                self._import_map_cache[file_path] = {r.import_statement: r for r in resolutions}
        return self._import_map_cache[file_path]

    def _resolve_base_class(
        self, file_path: str, registry: dict[str, ClassInfo], expr: str
    ) -> tuple[str, str] | None:
        """Resolves a raw base/constructor expression (e.g. "Base", "pkg.mod.Base")
        to the (file_path, class_name) it refers to. Same-file first, then via the
        file's own imports. Returns None for external/third-party/unresolvable
        classes — that's the existing import-resolution boundary, unchanged."""
        if expr in registry:
            return (file_path, expr)

        root = expr.split(".")[0]
        import_map = self._get_import_map(file_path)
        for resolution in import_map.values():
            if resolution.is_external or not resolution.resolved_file:
                continue
            if root in resolution.names or expr in resolution.names:
                target_registry = self._get_class_registry(resolution.resolved_file)
                if expr in target_registry:
                    return (resolution.resolved_file, expr)
                suffix = ".".join(expr.split(".")[1:])
                if suffix and suffix in target_registry:
                    return (resolution.resolved_file, suffix)
        return None

    def find_method_via_mro(
        self, file_path: str, class_name: str, method_name: str
    ) -> tuple[str, MethodInfo] | None:
        chain = resolve_mro(
            file_path,
            class_name,
            load_registry=self._get_class_registry,
            resolve_base=self._resolve_base_class,
        )
        for f, c in chain:
            registry = self._get_class_registry(f)
            info = registry.get(c)
            if info and method_name in info.methods:
                return f, info.methods[method_name]
        return None

    def _signature_for_method(self, file_path: str, method_info: MethodInfo) -> FunctionSignature:
        return FunctionSignature(
            name=method_info.qualified_name,
            qualified_name=f"{self._module_prefix(file_path)}.{method_info.qualified_name}",
            source_file=file_path,
            start_line=method_info.ast_node.lineno,
            parameters=self._extract_params(method_info.ast_node),
            is_external=False,
            is_resolvable=True,
            class_name=method_info.class_name,
            method_kind=method_info.method_kind,
        )

    def _module_prefix(self, file_path: str) -> str:
        try:
            rel = Path(file_path).resolve().relative_to(self.project_root)
            return ".".join(rel.with_suffix("").parts)
        except ValueError:
            return Path(file_path).stem

    # -------------------------------------------------------------------------

    def _resolve_via_imports(self, name: str, current_file: str) -> FunctionSignature | None:
        root = name.split(".")[0]
        for resolution in self.import_map.values():
            if root in resolution.names or name in resolution.names:
                if resolution.resolved_file and not resolution.is_external:
                    func_node = self.find_function_in_file(resolution.resolved_file, name.split(".")[-1])
                    if func_node:
                        rel = Path(resolution.resolved_file).relative_to(self.project_root)
                        qualified = ".".join(rel.with_suffix("").parts) + "." + name.split(".")[-1]
                        return FunctionSignature(
                            name=name,
                            qualified_name=qualified,
                            source_file=resolution.resolved_file,
                            start_line=func_node.lineno,
                            parameters=self._extract_params(func_node),
                            is_external=False,
                            is_resolvable=True,
                        )
                elif resolution.is_external:
                    return FunctionSignature(
                        name=name,
                        qualified_name=name,
                        source_file="<external>",
                        start_line=0,
                        parameters=[],
                        is_external=True,
                        is_resolvable=False,
                    )
        return None

    @staticmethod
    def _extract_call_name(call: ast.Call) -> str | None:
        if isinstance(call.func, ast.Name):
            return call.func.id
        if isinstance(call.func, ast.Attribute):
            parts = []
            node: ast.expr = call.func
            while isinstance(node, ast.Attribute):
                parts.append(node.attr)
                node = node.value
            if isinstance(node, ast.Name):
                parts.append(node.id)
                return ".".join(reversed(parts))
        return None

    @staticmethod
    def _extract_params(func_node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
        params = [arg.arg for arg in func_node.args.args]
        if func_node.args.vararg:
            params.append(f"*{func_node.args.vararg.arg}")
        if func_node.args.kwarg:
            params.append(f"**{func_node.args.kwarg.arg}")
        return params
