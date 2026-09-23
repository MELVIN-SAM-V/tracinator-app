from __future__ import annotations
import ast

# Cheap first filter, not the security boundary: the demo Lambda's real
# containment is a minimal role (CloudWatch Logs + VPC networking only), an
# isolated no-egress subnet, a memory-capped execution environment, a
# wall-clock timeout, and per-request working directories. This just
# rejects the obvious cases (and their error message) before spending a
# subprocess + timeout window on them.
BLOCKED_MODULES = {
    "os", "subprocess", "socket", "shutil", "ctypes", "multiprocessing",
    "importlib", "pickle", "marshal", "ftplib", "smtplib", "telnetlib",
    "http", "urllib", "ssl", "pty", "resource", "signal", "runpy", "imp",
    "pkgutil", "code", "codeop", "cffi",
}

BLOCKED_CALLS = {"eval", "exec", "__import__", "compile"}


class UnsafeSourceError(ValueError):
    pass


def check_source_safety(source: str) -> None:
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in BLOCKED_MODULES:
                    raise UnsafeSourceError(f"Import of '{root}' is not allowed in the demo sandbox")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root in BLOCKED_MODULES:
                raise UnsafeSourceError(f"Import of '{root}' is not allowed in the demo sandbox")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in BLOCKED_CALLS:
                raise UnsafeSourceError(f"Call to '{node.func.id}' is not allowed in the demo sandbox")
