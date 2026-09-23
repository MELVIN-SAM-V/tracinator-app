from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path

from tracinator.analyzer.call_resolver import MethodContext
from tracinator.analyzer.class_registry import DefEntry, display_params, iter_defs
from tracinator.models import (
    ControlFlowGraph,
    EdgeType,
    GraphEdge,
    GraphNode,
    MethodKind,
    NodeType,
)


@dataclass
class PendingExit:
    node_id: str
    edge_type: EdgeType = EdgeType.SEQUENTIAL
    edge_label: str | None = None


@dataclass
class BuildContext:
    break_exits: list[PendingExit] = field(default_factory=list)
    continue_target: str | None = None
    depth: int = 0
    max_depth: int = 5


class CFGBuilder:
    def __init__(
        self,
        source_file: str,
        source_lines: list[str],
        call_resolver=None,
        max_call_depth: int = 3,
        module_functions: dict[str, DefEntry] | None = None,
    ) -> None:
        self.source_file = source_file
        self.source_lines = source_lines
        self.call_resolver = call_resolver
        self.max_call_depth = max_call_depth
        self.module_functions: dict[str, DefEntry] = module_functions or {}
        self.method_ctx: MethodContext | None = None
        self.nodes: list[GraphNode] = []
        self.edges: list[GraphEdge] = []
        self._counters: dict[str, int] = {}
        self._call_occurrence_counts: dict[int, int] = {}
        self._func_name = ""
        self._qualified_prefix = ""

    def build(
        self,
        function_node: ast.FunctionDef,
        qualified_prefix: str = "",
        function_name: str = "",
        method_ctx: MethodContext | None = None,
    ) -> ControlFlowGraph:
        self.nodes = []
        self.edges = []
        self._counters = {}
        self._call_occurrence_counts = {}
        self._func_name = function_name or function_node.name
        self._qualified_prefix = qualified_prefix or function_node.name
        self.method_ctx = method_ctx

        method_kind = method_ctx.method_kind if method_ctx else None
        params = self._format_args(function_node.args, method_kind)
        entry = self._make_node(
            NodeType.ENTRY,
            label=f"{function_node.name}({params})",
            start_line=function_node.lineno,
            end_line=function_node.lineno,
        )

        local_funcs = self._collect_local_functions(function_node)
        ctx = BuildContext(max_depth=self.max_call_depth)
        first_id, exits = self._process_body(function_node.body, [PendingExit(entry.id)], ctx, local_funcs)

        exit_node_ids = [n.id for n in self.nodes if n.node_type in (NodeType.RETURN, NodeType.RAISE)]

        if exits:
            implicit_exit = self._make_node(
                NodeType.EXIT,
                label="return None (implicit)",
                start_line=getattr(function_node, "end_lineno", function_node.lineno),
                end_line=getattr(function_node, "end_lineno", function_node.lineno),
            )
            self._connect(exits, implicit_exit.id)
            exit_node_ids.append(implicit_exit.id)

        return ControlFlowGraph(
            function_name=self._func_name,
            qualified_name=self._qualified_prefix,
            source_file=self.source_file,
            start_line=function_node.lineno,
            end_line=getattr(function_node, "end_lineno", function_node.lineno),
            nodes=self.nodes,
            edges=self.edges,
            entry_node_id=entry.id,
            exit_node_ids=exit_node_ids,
        )

    # -------------------------------------------------------------------------
    # Body processing
    # -------------------------------------------------------------------------

    def _process_body(
        self,
        stmts: list[ast.stmt],
        predecessors: list[PendingExit],
        ctx: BuildContext,
        local_funcs: dict[str, DefEntry],
    ) -> tuple[str | None, list[PendingExit]]:
        """
        Returns (first_node_id, dangling_exits).
        first_node_id is the first node created in this body (None if empty).
        """
        if not stmts:
            return None, predecessors

        current_preds = list(predecessors)
        first_id: str | None = None
        simple_stmts: list[ast.stmt] = []

        def flush_simple() -> None:
            nonlocal first_id, current_preds
            if not simple_stmts:
                return
            node = self._make_statement_node(simple_stmts, local_funcs)
            self._connect(current_preds, node.id)
            if first_id is None:
                first_id = node.id
            current_preds.clear()
            current_preds.append(PendingExit(node.id))
            simple_stmts.clear()

        for stmt in stmts:
            if isinstance(stmt, (ast.If, ast.For, ast.While, ast.Try, ast.With)):
                flush_simple()
                nid, exits = self._process_structured(stmt, current_preds, ctx, local_funcs)
                if first_id is None:
                    first_id = nid
                current_preds = exits

            elif isinstance(stmt, (ast.Return, ast.Raise)):
                flush_simple()
                # Hoist any known calls from the return/raise expression
                if self.call_resolver:
                    all_known = {**self.module_functions, **local_funcs}
                    expr: ast.expr | None = None
                    if isinstance(stmt, ast.Return) and stmt.value:
                        expr = stmt.value
                    elif isinstance(stmt, ast.Raise) and stmt.exc:
                        expr = stmt.exc
                    if expr:
                        for call_ast, sig in self._collect_calls_ordered(expr, all_known):
                            cnode = self._make_call_node(call_ast, sig, stmt.lineno)
                            self._connect(current_preds, cnode.id)
                            if first_id is None:
                                first_id = cnode.id
                            current_preds = [PendingExit(cnode.id)]
                node = self._process_terminal(stmt)
                self._connect(current_preds, node.id)
                if first_id is None:
                    first_id = node.id
                current_preds = []  # terminal — nothing follows

            elif isinstance(stmt, ast.Break):
                flush_simple()
                node = self._make_node(
                    NodeType.BREAK,
                    label="break",
                    start_line=stmt.lineno,
                    end_line=stmt.lineno,
                    raw_code="break",
                )
                self._connect(current_preds, node.id)
                if first_id is None:
                    first_id = node.id
                ctx.break_exits.append(PendingExit(node.id))
                current_preds = []

            elif isinstance(stmt, ast.Continue):
                flush_simple()
                node = self._make_node(
                    NodeType.CONTINUE,
                    label="continue",
                    start_line=stmt.lineno,
                    end_line=stmt.lineno,
                    raw_code="continue",
                )
                self._connect(current_preds, node.id)
                if first_id is None:
                    first_id = node.id
                if ctx.continue_target:
                    self._add_edge(node.id, ctx.continue_target, EdgeType.LOOP_BACK, label="continue")
                current_preds = []

            else:
                if self.call_resolver:
                    all_known = {**self.module_functions, **local_funcs}
                    expr = self._get_stmt_expr(stmt)
                    if expr:
                        call_pairs = self._collect_calls_ordered(expr, all_known)
                        if call_pairs:
                            flush_simple()
                            for call_ast, sig in call_pairs:
                                cnode = self._make_call_node(call_ast, sig, stmt.lineno)
                                self._connect(current_preds, cnode.id)
                                if first_id is None:
                                    first_id = cnode.id
                                current_preds = [PendingExit(cnode.id)]
                            # Only keep the statement itself if it's not fully covered by the call(s)
                            outer_is_known = (
                                isinstance(stmt, ast.Expr)
                                and isinstance(stmt.value, ast.Call)
                                and any(c is stmt.value for c, _ in call_pairs)
                            )
                            if not outer_is_known:
                                simple_stmts.append(stmt)
                            continue
                simple_stmts.append(stmt)

        flush_simple()
        return first_id, current_preds

    # -------------------------------------------------------------------------
    # Structured statements
    # -------------------------------------------------------------------------

    def _process_structured(
        self,
        stmt: ast.stmt,
        predecessors: list[PendingExit],
        ctx: BuildContext,
        local_funcs: dict[str, DefEntry],
    ) -> tuple[str | None, list[PendingExit]]:
        if isinstance(stmt, ast.If):
            return self._process_if(stmt, predecessors, ctx, local_funcs)
        if isinstance(stmt, ast.For):
            return self._process_for(stmt, predecessors, ctx, local_funcs)
        if isinstance(stmt, ast.While):
            return self._process_while(stmt, predecessors, ctx, local_funcs)
        if isinstance(stmt, ast.Try):
            return self._process_try(stmt, predecessors, ctx, local_funcs)
        if isinstance(stmt, ast.With):
            return self._process_with(stmt, predecessors, ctx, local_funcs)
        return None, predecessors

    def _process_if(
        self,
        node: ast.If,
        predecessors: list[PendingExit],
        ctx: BuildContext,
        local_funcs: dict[str, DefEntry],
        is_elif: bool = False,
    ) -> tuple[str, list[PendingExit]]:
        condition = ast.unparse(node.test)
        # Python's grammar has no separate `elif` AST node — it's just an `ast.If`
        # nested in the parent's `orelse` — so the caller has to tell us via `is_elif`.
        node_type = NodeType.ELIF if is_elif else NodeType.IF
        keyword = "elif" if is_elif else "if"
        if_node = self._make_node(
            node_type,
            label=f"{keyword} {condition}",
            condition=condition,
            start_line=node.lineno,
            end_line=node.lineno,
        )
        self._connect(predecessors, if_node.id)

        true_preds = [PendingExit(if_node.id, EdgeType.TRUE, "True")]
        _, true_exits = self._process_body(node.body, true_preds, ctx, local_funcs)

        if node.orelse:
            if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
                # elif: convert to ELIF node connected via False edge
                elif_preds = [PendingExit(if_node.id, EdgeType.FALSE, "False")]
                _, false_exits = self._process_if(node.orelse[0], elif_preds, ctx, local_funcs, is_elif=True)
            else:
                false_preds = [PendingExit(if_node.id, EdgeType.FALSE, "False")]
                _, false_exits = self._process_body(node.orelse, false_preds, ctx, local_funcs)
        else:
            false_exits = [PendingExit(if_node.id, EdgeType.FALSE, "False")]

        return if_node.id, true_exits + false_exits

    def _process_for(
        self,
        node: ast.For,
        predecessors: list[PendingExit],
        ctx: BuildContext,
        local_funcs: dict[str, DefEntry],
    ) -> tuple[str, list[PendingExit]]:
        target = ast.unparse(node.target)
        iter_ = ast.unparse(node.iter)
        label = f"for {target} in {iter_}"
        for_node = self._make_node(
            NodeType.FOR,
            label=label,
            condition=label,
            start_line=node.lineno,
            end_line=node.lineno,
        )
        self._connect(predecessors, for_node.id)

        break_exits: list[PendingExit] = []
        loop_ctx = BuildContext(
            break_exits=break_exits,
            continue_target=for_node.id,
            depth=ctx.depth,
            max_depth=ctx.max_depth,
        )

        body_preds = [PendingExit(for_node.id, EdgeType.TRUE, "iterate")]
        _, body_exits = self._process_body(node.body, body_preds, loop_ctx, local_funcs)

        # Body exits loop back to for header
        for exit_pe in body_exits:
            self._add_edge(exit_pe.node_id, for_node.id, EdgeType.LOOP_BACK, label="next")

        if node.orelse:
            else_preds = [PendingExit(for_node.id, EdgeType.LOOP_EXIT, "exhausted")]
            _, else_exits = self._process_body(node.orelse, else_preds, ctx, local_funcs)
            loop_exits = else_exits
        else:
            loop_exits = [PendingExit(for_node.id, EdgeType.LOOP_EXIT, "done")]

        return for_node.id, loop_exits + break_exits

    def _process_while(
        self,
        node: ast.While,
        predecessors: list[PendingExit],
        ctx: BuildContext,
        local_funcs: dict[str, DefEntry],
    ) -> tuple[str, list[PendingExit]]:
        condition = ast.unparse(node.test)
        while_node = self._make_node(
            NodeType.WHILE,
            label=f"while {condition}",
            condition=condition,
            start_line=node.lineno,
            end_line=node.lineno,
        )
        self._connect(predecessors, while_node.id)

        break_exits: list[PendingExit] = []
        loop_ctx = BuildContext(
            break_exits=break_exits,
            continue_target=while_node.id,
            depth=ctx.depth,
            max_depth=ctx.max_depth,
        )

        body_preds = [PendingExit(while_node.id, EdgeType.TRUE, "True")]
        _, body_exits = self._process_body(node.body, body_preds, loop_ctx, local_funcs)

        for exit_pe in body_exits:
            self._add_edge(exit_pe.node_id, while_node.id, EdgeType.LOOP_BACK, label="repeat")

        if node.orelse:
            else_preds = [PendingExit(while_node.id, EdgeType.FALSE, "False")]
            _, else_exits = self._process_body(node.orelse, else_preds, ctx, local_funcs)
            loop_exits = else_exits
        else:
            loop_exits = [PendingExit(while_node.id, EdgeType.FALSE, "False")]

        return while_node.id, loop_exits + break_exits

    def _process_try(
        self,
        node: ast.Try,
        predecessors: list[PendingExit],
        ctx: BuildContext,
        local_funcs: dict[str, DefEntry],
    ) -> tuple[str, list[PendingExit]]:
        try_node = self._make_node(
            NodeType.TRY,
            label="try",
            start_line=node.lineno,
            end_line=node.lineno,
        )
        self._connect(predecessors, try_node.id)

        _, body_exits = self._process_body(
            node.body, [PendingExit(try_node.id)], ctx, local_funcs
        )

        all_handler_exits: list[PendingExit] = []
        for handler in node.handlers:
            exc_label = f"except {ast.unparse(handler.type)}" if handler.type else "except"
            except_node = self._make_node(
                NodeType.EXCEPT,
                label=exc_label,
                start_line=handler.lineno,
                end_line=handler.lineno,
            )
            self._add_edge(try_node.id, except_node.id, EdgeType.EXCEPTION, label=exc_label)
            _, handler_exits = self._process_body(
                handler.body, [PendingExit(except_node.id)], ctx, local_funcs
            )
            all_handler_exits.extend(handler_exits)

        combined = body_exits + all_handler_exits

        if node.finalbody:
            finally_node = self._make_node(
                NodeType.FINALLY,
                label="finally",
                start_line=node.finalbody[0].lineno,
                end_line=node.finalbody[-1].end_lineno,
            )
            self._connect(combined, finally_node.id)
            _, finally_exits = self._process_body(
                node.finalbody, [PendingExit(finally_node.id)], ctx, local_funcs
            )
            return try_node.id, finally_exits

        return try_node.id, combined

    def _process_with(
        self,
        node: ast.With,
        predecessors: list[PendingExit],
        ctx: BuildContext,
        local_funcs: dict[str, DefEntry],
    ) -> tuple[str, list[PendingExit]]:
        items_str = ", ".join(ast.unparse(item) for item in node.items)
        with_node = self._make_node(
            NodeType.WITH,
            label=f"with {items_str}",
            start_line=node.lineno,
            end_line=node.lineno,
        )
        self._connect(predecessors, with_node.id)
        _, exits = self._process_body(
            node.body, [PendingExit(with_node.id)], ctx, local_funcs
        )
        return with_node.id, exits

    def _process_terminal(self, stmt: ast.stmt) -> GraphNode:
        if isinstance(stmt, ast.Return):
            value_str = ast.unparse(stmt.value) if stmt.value else "None"
            return self._make_node(
                NodeType.RETURN,
                label=f"return {value_str}",
                raw_code=f"return {value_str}",
                start_line=stmt.lineno,
                end_line=stmt.lineno,
            )
        if isinstance(stmt, ast.Raise):
            exc_str = ast.unparse(stmt.exc) if stmt.exc else "re-raise"
            return self._make_node(
                NodeType.RAISE,
                label=f"raise {exc_str}",
                raw_code=f"raise {exc_str}",
                start_line=stmt.lineno,
                end_line=stmt.lineno,
            )
        raise ValueError(f"Not a terminal: {type(stmt)}")

    # -------------------------------------------------------------------------
    # Statement node creation
    # -------------------------------------------------------------------------

    def _get_stmt_expr(self, stmt: ast.stmt) -> ast.expr | None:
        """Return the value expression of a simple statement, if any."""
        if isinstance(stmt, ast.Expr):
            return stmt.value
        if isinstance(stmt, (ast.Assign, ast.AugAssign)):
            return stmt.value
        if isinstance(stmt, ast.AnnAssign) and stmt.value:
            return stmt.value
        return None

    def _collect_calls_ordered(
        self,
        expr: ast.expr,
        all_known: dict,
    ) -> list[tuple[ast.Call, object]]:
        """
        Walk expr and return (call_node, sig) for every call to a known
        (non-external) function, in evaluation order (innermost first).
        """
        results: list[tuple[ast.Call, object]] = []
        seen: set[int] = set()

        def visit(node: ast.expr) -> None:
            if not isinstance(node, ast.Call):
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, ast.expr):
                        visit(child)  # type: ignore[arg-type]
                return
            for arg in node.args:
                visit(arg)
            for kw in node.keywords:
                visit(kw.value)
            nid = id(node)
            if nid in seen:
                return
            seen.add(nid)
            sig = self.call_resolver.resolve_call(node, self.source_file, all_known, self.method_ctx)
            if sig and not sig.is_external:
                results.append((node, sig))

        visit(expr)
        return results

    def _make_call_node(self, call_ast: ast.Call, sig: object, lineno: int) -> GraphNode:
        """Create a CALL graph node for a resolved function call."""
        args_str = ", ".join(ast.unparse(a) for a in call_ast.args)
        occurrence = self._call_occurrence_counts.get(lineno, 0)
        self._call_occurrence_counts[lineno] = occurrence + 1
        return self._make_node(
            NodeType.CALL,
            label=f"→ {sig.name}({args_str})",  # type: ignore[attr-defined]
            raw_code=ast.unparse(call_ast),
            start_line=lineno,
            end_line=lineno,
            called_function=sig.qualified_name,  # type: ignore[attr-defined]
            call_occurrence=occurrence,
        )

    def _make_statement_node(
        self,
        stmts: list[ast.stmt],
        local_funcs: dict[str, DefEntry],
    ) -> GraphNode:
        start = stmts[0].lineno
        end = getattr(stmts[-1], "end_lineno", stmts[-1].lineno)
        raw = "\n".join(self._get_line(s.lineno) for s in stmts)
        label = self._summarize_stmts(stmts)
        return self._make_node(
            NodeType.STATEMENT,
            label=label,
            raw_code=raw,
            start_line=start,
            end_line=end,
        )

    def _summarize_stmts(self, stmts: list[ast.stmt]) -> str:
        lines = []
        for stmt in stmts:
            try:
                lines.append(ast.unparse(stmt))
            except Exception:
                lines.append(self._get_line(stmt.lineno))
        if len(lines) > 4:
            return "\n".join(lines[:3]) + f"\n… ({len(lines) - 3} more lines)"
        return "\n".join(lines)

    # -------------------------------------------------------------------------
    # Node / edge helpers
    # -------------------------------------------------------------------------

    def _make_node(
        self,
        node_type: NodeType,
        label: str,
        start_line: int,
        end_line: int,
        raw_code: str = "",
        condition: str | None = None,
        called_function: str | None = None,
        call_occurrence: int = 0,
    ) -> GraphNode:
        key = node_type.name.lower()
        count = self._counters.get(key, 0)
        self._counters[key] = count + 1
        node_id = f"{self._qualified_prefix}.{key}_{start_line}_{count}"
        node = GraphNode(
            id=node_id,
            node_type=node_type,
            label=label,
            source_file=self.source_file,
            start_line=start_line,
            end_line=end_line,
            raw_code=raw_code,
            condition=condition,
            called_function=called_function,
            call_occurrence=call_occurrence,
        )
        self.nodes.append(node)
        return node

    def _add_edge(
        self,
        source_id: str,
        target_id: str,
        edge_type: EdgeType,
        label: str | None = None,
    ) -> GraphEdge:
        edge_id = f"edge_{source_id}__{target_id}_{edge_type.name.lower()}"
        edge = GraphEdge(
            id=edge_id,
            source_id=source_id,
            target_id=target_id,
            edge_type=edge_type,
            label=label,
        )
        self.edges.append(edge)
        return edge

    def _connect(self, exits: list[PendingExit], target_id: str) -> None:
        for pe in exits:
            self._add_edge(pe.node_id, target_id, pe.edge_type, pe.edge_label)

    def _get_line(self, lineno: int) -> str:
        if 1 <= lineno <= len(self.source_lines):
            return self.source_lines[lineno - 1].strip()
        return ""

    @staticmethod
    def _format_args(args: ast.arguments, method_kind: MethodKind | None = None) -> str:
        params = display_params([arg.arg for arg in args.args], method_kind)
        if args.vararg:
            params.append(f"*{args.vararg.arg}")
        for arg in args.kwonlyargs:
            params.append(arg.arg)
        if args.kwarg:
            params.append(f"**{args.kwarg.arg}")
        return ", ".join(params)

    @staticmethod
    def _collect_local_functions(function_node: ast.FunctionDef) -> dict[str, DefEntry]:
        return {entry.qualified_name: entry for entry in iter_defs(function_node)}
