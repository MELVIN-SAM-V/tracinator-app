import ast
from pathlib import Path

from tracinator.models import MethodKind, ProjectContext
from tracinator.analyzer.parser import parse_file, find_function
from tracinator.analyzer.import_resolver import ImportResolver
from tracinator.analyzer.call_resolver import CallResolver, MethodContext
from tracinator.analyzer.cfg_builder import CFGBuilder
from tracinator.analyzer.class_registry import DefEntry, iter_defs
from tracinator.analyzer.variable_extractor import extract_variables


def build_project_context(
    file_path: str,
    function_name: str,
    project_root: str,
    max_call_depth: int = 3,
) -> ProjectContext:
    file_path = str(Path(file_path).resolve())
    project_root = str(Path(project_root).resolve())

    ctx = ProjectContext(
        project_root=project_root,
        entry_file=file_path,
        entry_function=function_name,
    )

    import_resolver = ImportResolver(project_root)
    tree, source_lines = parse_file(file_path)

    import_resolutions = import_resolver.resolve_imports(tree, file_path)
    import_map = {r.import_statement: r for r in import_resolutions}
    ctx.import_map = import_map

    call_resolver = CallResolver(project_root, import_map)

    try:
        rel = Path(file_path).relative_to(project_root)
    except ValueError:
        # File is outside the project root (e.g. a temp file) — use its parent dir
        project_root = str(Path(file_path).parent)
        rel = Path(file_path).relative_to(project_root)
    qualified_prefix = ".".join(rel.with_suffix("").parts) + "." + function_name
    ctx.entry_qualified_name = qualified_prefix

    _analyze_function(
        file_path=file_path,
        function_name=function_name,
        qualified_prefix=qualified_prefix,
        source_lines=source_lines,
        call_resolver=call_resolver,
        import_resolver=import_resolver,
        ctx=ctx,
        depth=0,
        max_depth=max_call_depth,
        visited_functions=set(),
    )

    return ctx


def _build_method_ctx(
    entry_def: DefEntry | None,
    func_node,
    file_path: str,
    call_resolver: CallResolver,
) -> MethodContext:
    """Built for every function (plain or method) — local_var_types tracking
    (`x = SomeClass(...); x.method()`) applies regardless of whether the
    *containing* function is itself a method."""
    class_name = entry_def.class_name if entry_def else None
    method_kind = entry_def.method_kind if entry_def else None

    self_param = None
    if class_name is not None and method_kind != MethodKind.STATICMETHOD and func_node.args.args:
        self_param = func_node.args.args[0].arg

    return MethodContext(
        class_name=class_name,
        self_param=self_param,
        is_bound=class_name is not None and method_kind != MethodKind.STATICMETHOD,
        method_kind=method_kind,
        local_var_types=call_resolver.build_local_var_types(func_node, file_path),
    )


def _analyze_function(
    file_path: str,
    function_name: str,
    qualified_prefix: str,
    source_lines: list[str],
    call_resolver: CallResolver,
    import_resolver: ImportResolver,
    ctx: ProjectContext,
    depth: int,
    max_depth: int,
    visited_functions: set[str],
) -> None:
    if qualified_prefix in visited_functions:
        return
    visited_functions.add(qualified_prefix)

    tree, lines = parse_file(file_path)
    func_node = find_function(tree, function_name, file_path)

    entries = list(iter_defs(tree))
    entry_def = next((e for e in entries if e.ast_node is func_node), None)
    resolved_function_name = entry_def.qualified_name if entry_def else function_name

    # Deliberately includes func_node's own entry (unlike the old ast.walk-based
    # version) — a function calling itself (recursion) needs to find its own
    # signature here to resolve, same as calling any other function.
    module_functions = {e.qualified_name: e for e in entries}

    method_ctx = _build_method_ctx(entry_def, func_node, file_path, call_resolver)

    builder = CFGBuilder(
        source_file=file_path,
        source_lines=lines,
        call_resolver=call_resolver if depth < max_depth else None,
        max_call_depth=max_depth - depth,
        module_functions=module_functions,
    )
    cfg = builder.build(
        func_node,
        qualified_prefix=qualified_prefix,
        function_name=resolved_function_name,
        method_ctx=method_ctx,
    )
    ctx.all_graphs[qualified_prefix] = cfg

    variables = extract_variables(func_node, file_path)
    ctx.variables[qualified_prefix] = variables

    if depth >= max_depth:
        return

    # Resolve and analyze called functions
    local_funcs = {entry.qualified_name: entry for entry in iter_defs(func_node)}
    all_known_funcs = {**module_functions, **local_funcs}

    for node in cfg.nodes:
        if not node.called_function:
            continue

        # If already analyzed, just wire up the sub_graph (handles duplicate calls)
        existing = ctx.all_graphs.get(node.called_function)
        if existing:
            node.sub_graph = existing
            continue

        if node.called_function in visited_functions:
            continue

        sig = ctx.all_signatures.get(node.called_function)
        if sig is None:
            for sub_node in ast.walk(func_node):
                if not isinstance(sub_node, ast.Call):
                    continue
                resolved = call_resolver.resolve_call(sub_node, file_path, all_known_funcs, method_ctx)
                if resolved and resolved.qualified_name == node.called_function:
                    sig = resolved
                    ctx.all_signatures[resolved.qualified_name] = resolved
                    break

        if sig and not sig.is_external and sig.is_resolvable and sig.source_file != "<unknown>":
            try:
                _analyze_function(
                    file_path=sig.source_file,
                    function_name=sig.name,
                    qualified_prefix=sig.qualified_name,
                    source_lines=[],
                    call_resolver=call_resolver,
                    import_resolver=import_resolver,
                    ctx=ctx,
                    depth=depth + 1,
                    max_depth=max_depth,
                    visited_functions=visited_functions,
                )
                sub_graph = ctx.all_graphs.get(sig.qualified_name)
                if sub_graph:
                    node.sub_graph = sub_graph
            except (FileNotFoundError, ValueError, SyntaxError):
                pass
