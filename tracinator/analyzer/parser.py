import ast
from pathlib import Path

from tracinator.analyzer.class_registry import iter_defs


def parse_file(file_path: str) -> tuple[ast.Module, list[str]]:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")
    source = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=file_path)
    except SyntaxError as e:
        raise SyntaxError(f"Syntax error in {file_path} at line {e.lineno}: {e.msg}") from e
    return tree, source.splitlines()


def find_function(tree: ast.Module, name: str, file_path: str) -> ast.FunctionDef:
    """Resolves both plain function names and dotted class-relative method names
    (e.g. "Foo.bar", "Outer.Inner.method"). Collision policy: try an exact dotted
    match first; if `name` has no dots and matches exactly one entry, accept it
    (preserves plain-function ergonomics); if it matches more than one (e.g. two
    unrelated classes with a same-named method), raise listing the ambiguous
    qualified names rather than silently picking one."""
    entries = list(iter_defs(tree))
    by_qualified = {e.qualified_name: e for e in entries}

    if name in by_qualified:
        return by_qualified[name].ast_node  # type: ignore[return-value]

    if "." not in name:
        matches = [e for e in entries if e.name == name]
        if len(matches) == 1:
            return matches[0].ast_node  # type: ignore[return-value]
        if len(matches) > 1:
            qnames = ", ".join(sorted(e.qualified_name for e in matches))
            raise ValueError(
                f"'{name}' is ambiguous in {file_path} — matches: {qnames}. "
                f"Use the dotted Class.method form to disambiguate."
            )

    available = sorted(by_qualified.keys())
    available_str = ", ".join(available) if available else "none found"
    raise ValueError(
        f"Function '{name}' not found in {file_path}. "
        f"Available functions: {available_str}"
    )


def get_source_segment(source_lines: list[str], start_line: int, end_line: int) -> str:
    lines = source_lines[start_line - 1 : end_line]
    if not lines:
        return ""
    indent = len(lines[0]) - len(lines[0].lstrip())
    return "\n".join(line[indent:] for line in lines)
