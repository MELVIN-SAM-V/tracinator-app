from __future__ import annotations
from typing import Any
from tracinator.models import GraphNode, GraphEdge, ControlFlowGraph, ProjectContext


def serialize_node(node: GraphNode) -> dict[str, Any]:
    return {
        "id": node.id,
        "node_type": node.node_type.name,
        "label": node.label,
        "source_file": node.source_file,
        "start_line": node.start_line,
        "end_line": node.end_line,
        "raw_code": node.raw_code,
        "condition": node.condition,
        "is_collapsed": node.is_collapsed,
        "called_function": node.called_function,
        "call_occurrence": node.call_occurrence,
        "sub_graph": _serialize_sub_graph_ref(node.sub_graph) if node.sub_graph else None,
    }


def _serialize_sub_graph_ref(cfg: ControlFlowGraph) -> dict[str, Any]:
    """A lightweight pointer to a callee's graph — just enough for the frontend to
    navigate to it (source_file + function_name) and to know navigation is possible
    at all. Deliberately NOT the full nested cfg: that's already available, once,
    flat in ProjectContext.all_graphs. Embedding the full structure here would
    duplicate it at every call site, and for a recursive call site (a function's own
    CALL node pointing back at the very cfg it's part of) creates a literal object
    cycle — serialize_cfg -> serialize_node -> serialize_cfg -> ... -> RecursionError.
    """
    return {
        "function_name": cfg.function_name,
        "qualified_name": cfg.qualified_name,
        "source_file": cfg.source_file,
    }


def serialize_edge(edge: GraphEdge) -> dict[str, Any]:
    return {
        "id": edge.id,
        "source_id": edge.source_id,
        "target_id": edge.target_id,
        "edge_type": edge.edge_type.name,
        "label": edge.label,
    }


def serialize_cfg(cfg: ControlFlowGraph) -> dict[str, Any]:
    return {
        "function_name": cfg.function_name,
        "qualified_name": cfg.qualified_name,
        "source_file": cfg.source_file,
        "start_line": cfg.start_line,
        "end_line": cfg.end_line,
        "nodes": [serialize_node(n) for n in cfg.nodes],
        "edges": [serialize_edge(e) for e in cfg.edges],
        "entry_node_id": cfg.entry_node_id,
        "exit_node_ids": cfg.exit_node_ids,
    }


def serialize_context(ctx: ProjectContext) -> dict[str, Any]:
    return {
        "project_root": ctx.project_root,
        "entry_file": ctx.entry_file,
        "entry_function": ctx.entry_function,
        "all_graphs": {k: serialize_cfg(v) for k, v in ctx.all_graphs.items()},
    }
