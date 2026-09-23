from __future__ import annotations

from tracinator.analyzer.class_registry import display_params
from tracinator.models import MethodKind


def find_init_same_file(registry: dict, class_name: str, seen: set | None = None):
    """Same-file-only __init__ lookup (no cross-file import resolution) — used for
    the ephemeral in-memory editor source, which has no real file on disk to resolve
    imports against. Simple DFS over base_names, not full C3 — good enough for a
    constructor-args hint in that context; real tracing resolves through the actual
    file via CallResolver.find_method_via_mro."""
    seen = seen or set()
    if class_name in seen or class_name not in registry:
        return None
    seen.add(class_name)
    info = registry[class_name]
    if "__init__" in info.methods:
        return info.methods["__init__"]
    for base in info.base_names:
        if base in registry:
            found = find_init_same_file(registry, base, seen)
            if found:
                return found
    return None


def _declared_param_names(args) -> list[str]:
    """Every by-name-addressable parameter, in declaration order — positional-only,
    regular, and keyword-only (`ast.arguments.args` alone skips the last two:
    positional-only params live in their own `posonlyargs` list, and keyword-only
    params — anything after a bare `*` — live in `kwonlyargs`, not `args`). `*args`/
    `**kwargs` are deliberately excluded: there's no single value to prompt for."""
    return [a.arg for a in (*args.posonlyargs, *args.args, *args.kwonlyargs)]


def function_item(entry, constructor_lookup) -> dict:
    raw_args = _declared_param_names(entry.ast_node.args)
    item = {
        "name": entry.name,
        "qualified_name": entry.qualified_name,
        "class_name": entry.class_name,
        "method_kind": entry.method_kind.name.lower() if entry.method_kind else None,
        "line": entry.ast_node.lineno,
        "args": display_params(raw_args, entry.method_kind),
    }
    if entry.method_kind == MethodKind.INSTANCE:
        ctor = constructor_lookup(entry.class_name)
        ctor_args = _declared_param_names(ctor.ast_node.args) if ctor else []
        item["constructor_args"] = display_params(ctor_args, MethodKind.INSTANCE)
    return item
