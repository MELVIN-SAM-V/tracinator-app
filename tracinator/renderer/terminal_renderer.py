from __future__ import annotations

import os
from pathlib import Path

from rich.columns import Columns
from rich.console import Console, RenderableType
from rich.panel import Panel
from rich.rule import Rule
from rich.text import Text

from tracinator.models import ControlFlowGraph, NodeType, GraphNode, ProjectContext
from tracinator.renderer.layout import (
    Block,
    BranchBlock,
    LeafBlock,
    LoopBlock,
    SequenceBlock,
    StructureAnalyzer,
    TryBlock,
)


# ─── Node style configuration ─────────────────────────────────────────────────

_NODE_STYLE: dict[NodeType, tuple[str, str]] = {
    NodeType.ENTRY:     ("bold green",    "rounded"),
    NodeType.EXIT:      ("bold green",    "rounded"),
    NodeType.RETURN:    ("bold green",    "rounded"),
    NodeType.RAISE:     ("bold red",      "rounded"),
    NodeType.STATEMENT: ("white",         "solid"),
    NodeType.IF:        ("bold yellow",   "heavy"),
    NodeType.ELIF:      ("bold yellow",   "heavy"),
    NodeType.ELSE:      ("yellow",        "solid"),
    NodeType.FOR:       ("bold cyan",     "heavy"),
    NodeType.WHILE:     ("bold cyan",     "heavy"),
    NodeType.CALL:      ("bold blue",     "solid"),
    NodeType.TRY:       ("dim white",     "solid"),
    NodeType.EXCEPT:    ("bold orange3",  "solid"),
    NodeType.FINALLY:   ("dim white",     "solid"),
    NodeType.WITH:      ("dim cyan",      "solid"),
    NodeType.BREAK:     ("bold magenta",  "solid"),
    NodeType.CONTINUE:  ("bold magenta",  "solid"),
}

_NODE_PREFIX: dict[NodeType, str] = {
    NodeType.ENTRY:     "▶",
    NodeType.EXIT:      "◀",
    NodeType.RETURN:    "◀",
    NodeType.RAISE:     "✗",
    NodeType.IF:        "◇",
    NodeType.ELIF:      "◇",
    NodeType.FOR:       "⟳",
    NodeType.WHILE:     "⟳",
    NodeType.CALL:      "→",
    NodeType.TRY:       "⊡",
    NodeType.EXCEPT:    "!",
    NodeType.BREAK:     "⤸",
    NodeType.CONTINUE:  "↺",
}

_ARROW = Text("     │\n     ▼", style="dim white")
_BRANCH_DOWN = Text("     │", style="dim white")


class TerminalRenderer:
    def __init__(self, max_width: int | None = None) -> None:
        self.max_width = max_width or _terminal_width()

    def render(self, ctx: ProjectContext) -> None:
        console = Console(width=self.max_width)
        cfg = ctx.all_graphs.get(
            next(
                (k for k in ctx.all_graphs if k.endswith(ctx.entry_function)),
                ctx.entry_function,
            )
        )
        if cfg is None:
            console.print(f"[bold red]No graph found for {ctx.entry_function}[/]")
            return

        self._render_cfg(cfg, console)

    def render_cfg(self, cfg: ControlFlowGraph, console: Console | None = None) -> None:
        if console is None:
            console = Console(width=self.max_width)
        self._render_cfg(cfg, console)

    def _render_cfg(self, cfg: ControlFlowGraph, console: Console) -> None:
        rel_path = _relative_path(cfg.source_file)
        console.print()
        console.rule(
            f"[bold cyan]Tracinator[/]  [white]{rel_path}[/] [dim]›[/] [bold white]{cfg.function_name}()[/]",
            style="dim cyan",
        )
        console.print()

        analyzer = StructureAnalyzer(cfg)
        block = analyzer.analyze()
        renderable = self._render_block(block)
        console.print(renderable)

        console.print()
        paths = cfg.all_paths()
        node_count = len(cfg.nodes)
        edge_count = len(cfg.edges)
        files = len({n.source_file for n in cfg.nodes})
        console.rule(
            f"[dim]Nodes: {node_count}   Edges: {edge_count}   "
            f"Paths: {len(paths)}   Files: {files}[/]",
            style="dim",
        )
        console.print()

    # ─── Block rendering ──────────────────────────────────────────────────────

    def _render_block(self, block: Block) -> RenderableType:
        if isinstance(block, LeafBlock):
            return self._render_node(block.node)

        if isinstance(block, SequenceBlock):
            return self._render_sequence(block)

        if isinstance(block, BranchBlock):
            return self._render_branch(block)

        if isinstance(block, LoopBlock):
            return self._render_loop(block)

        if isinstance(block, TryBlock):
            return self._render_try(block)

        return Text(f"[unknown block: {type(block).__name__}]", style="red")

    def _render_sequence(self, block: SequenceBlock) -> RenderableType:
        from rich.console import Group

        parts: list[RenderableType] = []
        for i, child in enumerate(block.children):
            if child is None:
                continue
            parts.append(self._render_block(child))
            if i < len(block.children) - 1:
                parts.append(_ARROW)
        return Group(*parts)

    def _render_branch(self, block: BranchBlock) -> RenderableType:
        from rich.console import Group

        cond = self._render_node(block.condition)

        true_header = Text("  ✔ True", style="bold green")
        false_header = Text("  ✘ False", style="bold red")

        true_content = self._render_block(block.true_branch) if block.true_branch else Text("  (fall through)", style="dim")
        false_content = self._render_block(block.false_branch) if block.false_branch else Text("  (fall through)", style="dim")

        true_col = Group(true_header, Text("     │\n     ▼", style="dim green"), true_content)
        false_col = Group(false_header, Text("     │\n     ▼", style="dim red"), false_content)

        branch_cols = Columns([true_col, false_col], padding=(0, 3), expand=False)

        return Group(cond, _BRANCH_DOWN, branch_cols)

    def _render_loop(self, block: LoopBlock) -> RenderableType:
        from rich.console import Group

        header = self._render_node(block.header)

        if block.body:
            body_render = self._render_block(block.body)
            loop_back = Text("     │\n     └──── loop back ─────▶", style="dim magenta")
            # Exit label only — the parent SequenceBlock adds the │ ▼ arrow
            exit_label = Text("     │ exit", style="dim cyan")
            return Group(header, _ARROW, body_render, loop_back, exit_label)
        else:
            return Group(header, Text("     │ (empty loop body)", style="dim"))

    def _render_try(self, block: TryBlock) -> RenderableType:
        from rich.console import Group

        parts: list[RenderableType] = [self._render_node(block.try_node)]

        if block.body:
            parts.append(_ARROW)
            parts.append(self._render_block(block.body))

        for exc_node, handler_body in block.handlers:
            parts.append(Text("\n     │ exception\n     ▼", style="dim orange3"))
            parts.append(self._render_node(exc_node))
            if handler_body:
                parts.append(_ARROW)
                parts.append(self._render_block(handler_body))

        if block.finally_block:
            parts.append(Text("\n     │ finally\n     ▼", style="dim white"))
            parts.append(self._render_block(block.finally_block))

        return Group(*parts)

    # ─── Node rendering ───────────────────────────────────────────────────────

    def _render_node(self, node: GraphNode) -> RenderableType:
        from rich.text import Text as RText

        style, box_name = _NODE_STYLE.get(node.node_type, ("white", "solid"))
        prefix = _NODE_PREFIX.get(node.node_type, "")

        title_text = f"{prefix} {node.node_type.name}" if prefix else node.node_type.name
        title = RText(f" {title_text} ", style=style)

        rel = _relative_path(node.source_file)
        loc = RText(f"{rel}:{node.start_line}", style="dim white")

        label_text = RText(node.label, overflow="fold")

        from rich.console import Group as RGroup
        content = RGroup(label_text, loc)

        box = _get_box(box_name)

        return Panel(
            content,
            title=title,
            box=box,
            border_style=style,
            padding=(0, 1),
            expand=False,
        )


# ─── Utilities ────────────────────────────────────────────────────────────────

def _terminal_width() -> int:
    try:
        return min(os.get_terminal_size().columns, 160)
    except OSError:
        return 120


def _relative_path(file_path: str) -> str:
    try:
        return str(Path(file_path).relative_to(Path.cwd()))
    except ValueError:
        return Path(file_path).name


def _get_box(name: str):
    from rich import box
    mapping = {
        "rounded": box.ROUNDED,
        "heavy":   box.HEAVY,
        "solid":   box.SQUARE,
        "dashed":  box.ASCII,
    }
    return mapping.get(name, box.SQUARE)
