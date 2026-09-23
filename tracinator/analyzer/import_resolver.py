import ast
from pathlib import Path

from tracinator.models import ImportResolution


class ImportResolver:
    def __init__(self, project_root: str) -> None:
        self.project_root = Path(project_root).resolve()

    def resolve_imports(self, tree: ast.Module, current_file: str) -> list[ImportResolution]:
        current_path = Path(current_file).resolve()
        results: list[ImportResolution] = []

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    resolution = self._resolve_module(alias.name, current_path)
                    resolution.import_statement = f"import {alias.name}"
                    results.append(resolution)

            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                level = node.level  # number of leading dots (relative import)
                names = [alias.name for alias in node.names]
                resolution = self._resolve_from_import(module, names, level, current_path)
                resolution.import_statement = self._format_from_import(module, names, level)
                results.append(resolution)

        return results

    def resolve_name_to_file(self, qualified_name: str) -> str | None:
        parts = qualified_name.split(".")
        for i in range(len(parts), 0, -1):
            module_path = Path(self.project_root, *parts[:i]).with_suffix(".py")
            if module_path.exists():
                return str(module_path)
            init_path = Path(self.project_root, *parts[:i], "__init__.py")
            if init_path.exists():
                return str(init_path)
        return None

    def _resolve_module(self, module_name: str, current_file: Path) -> ImportResolution:
        parts = module_name.split(".")
        candidate = Path(self.project_root, *parts).with_suffix(".py")
        if candidate.exists():
            return ImportResolution(
                import_statement="",
                resolved_file=str(candidate),
                names=[parts[-1]],
                is_external=False,
            )
        init_candidate = Path(self.project_root, *parts, "__init__.py")
        if init_candidate.exists():
            return ImportResolution(
                import_statement="",
                resolved_file=str(init_candidate),
                names=[parts[-1]],
                is_external=False,
            )
        return ImportResolution(
            import_statement="",
            resolved_file=None,
            names=[parts[-1]],
            is_external=True,
        )

    def _resolve_from_import(
        self, module: str, names: list[str], level: int, current_file: Path
    ) -> ImportResolution:
        if level > 0:
            # Relative import
            base = current_file.parent
            for _ in range(level - 1):
                base = base.parent
            parts = module.split(".") if module else []
            candidate = Path(base, *parts).with_suffix(".py")
            if candidate.exists():
                return ImportResolution(
                    import_statement="",
                    resolved_file=str(candidate),
                    names=names,
                    is_external=False,
                )
            init_candidate = Path(base, *parts, "__init__.py") if parts else Path(base, "__init__.py")
            if init_candidate.exists():
                return ImportResolution(
                    import_statement="",
                    resolved_file=str(init_candidate),
                    names=names,
                    is_external=False,
                )
        else:
            # Absolute import
            parts = module.split(".") if module else []
            candidate = Path(self.project_root, *parts).with_suffix(".py")
            if candidate.exists():
                return ImportResolution(
                    import_statement="",
                    resolved_file=str(candidate),
                    names=names,
                    is_external=False,
                )
            init_candidate = Path(self.project_root, *parts, "__init__.py")
            if init_candidate.exists():
                return ImportResolution(
                    import_statement="",
                    resolved_file=str(init_candidate),
                    names=names,
                    is_external=False,
                )

        return ImportResolution(
            import_statement="",
            resolved_file=None,
            names=names,
            is_external=True,
        )

    @staticmethod
    def _format_from_import(module: str, names: list[str], level: int) -> str:
        dots = "." * level
        names_str = ", ".join(names)
        return f"from {dots}{module} import {names_str}"
