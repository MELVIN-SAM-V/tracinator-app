from __future__ import annotations

from dataclasses import dataclass, field
from collections import deque

from tracinator.models import ControlFlowGraph, EdgeType, GraphNode, NodeType


# ─── Block tree types ────────────────────────────────────────────────────────

class Block:
    pass


@dataclass
class LeafBlock(Block):
    node: GraphNode


@dataclass
class SequenceBlock(Block):
    children: list[Block]


@dataclass
class BranchBlock(Block):
    condition: GraphNode
    true_branch: Block | None
    false_branch: Block | None


@dataclass
class LoopBlock(Block):
    header: GraphNode
    body: Block | None
    is_while: bool = False


@dataclass
class TryBlock(Block):
    try_node: GraphNode
    body: Block | None
    handlers: list[tuple[GraphNode, Block | None]]  # (except_node, body)
    finally_block: Block | None


# ─── Structure analyzer ───────────────────────────────────────────────────────

class StructureAnalyzer:
    def __init__(self, cfg: ControlFlowGraph) -> None:
        self.cfg = cfg
        self._topo: list[str] = topo_sort(cfg)
        self._topo_index: dict[str, int] = {nid: i for i, nid in enumerate(self._topo)}

    def analyze(self) -> Block:
        result = self._visit(self.cfg.entry_node_id, frozenset(), None)
        return result or LeafBlock(self.cfg.get_node(self.cfg.entry_node_id))

    def _visit(self, node_id: str, visited: frozenset, stop_at: str | None) -> Block | None:
        if node_id is None or node_id in visited or node_id == stop_at:
            return None

        node = self.cfg.get_node(node_id)
        if node is None:
            return None

        visited = visited | {node_id}
        forward = [
            e for e in self.cfg.get_outgoing_edges(node_id)
            if e.edge_type not in (EdgeType.LOOP_BACK,)
        ]

        if node.node_type in (NodeType.FOR, NodeType.WHILE):
            return self._visit_loop(node, forward, visited, stop_at)

        if node.node_type in (NodeType.IF, NodeType.ELIF):
            return self._visit_branch(node, forward, visited, stop_at)

        if node.node_type == NodeType.TRY:
            return self._visit_try(node, forward, visited, stop_at)

        if not forward:
            return LeafBlock(node)

        if len(forward) == 1:
            tail = self._visit(forward[0].target_id, visited, stop_at)
            if tail:
                return SequenceBlock([LeafBlock(node), tail])
            return LeafBlock(node)

        # Unexpected multi-exit — just render the node
        return LeafBlock(node)

    def _visit_loop(
        self,
        node: GraphNode,
        forward: list,
        visited: frozenset,
        stop_at: str | None,
    ) -> Block:
        # FOR loops: body = TRUE, exit = LOOP_EXIT
        # WHILE loops: body = TRUE, exit = FALSE (when no else clause)
        body_edge = next((e for e in forward if e.edge_type == EdgeType.TRUE), None)
        exit_edge = next(
            (e for e in forward if e.edge_type in (EdgeType.LOOP_EXIT, EdgeType.FALSE)),
            None,
        )

        body_block = None
        if body_edge:
            body_block = self._visit(body_edge.target_id, visited, None)

        loop = LoopBlock(header=node, body=body_block, is_while=node.node_type == NodeType.WHILE)

        after = None
        if exit_edge and exit_edge.target_id not in visited:
            after = self._visit(exit_edge.target_id, visited, stop_at)

        if after:
            return SequenceBlock([loop, after])
        return loop

    def _visit_branch(
        self,
        node: GraphNode,
        forward: list,
        visited: frozenset,
        stop_at: str | None,
    ) -> Block:
        true_edge = next((e for e in forward if e.edge_type == EdgeType.TRUE), None)
        false_edge = next((e for e in forward if e.edge_type == EdgeType.FALSE), None)

        true_id = true_edge.target_id if true_edge else None
        false_id = false_edge.target_id if false_edge else None

        merge_id = self._find_merge(true_id, false_id, visited)

        merge_visited = visited | ({merge_id} if merge_id else set())

        true_block = self._visit(true_id, merge_visited, merge_id) if true_id else None
        false_block = self._visit(false_id, merge_visited, merge_id) if false_id else None

        branch = BranchBlock(condition=node, true_branch=true_block, false_branch=false_block)

        after = None
        if merge_id and merge_id not in visited:
            after = self._visit(merge_id, visited, stop_at)

        if after:
            return SequenceBlock([branch, after])
        return branch

    def _visit_try(
        self,
        node: GraphNode,
        forward: list,
        visited: frozenset,
        stop_at: str | None,
    ) -> Block:
        body_edge = next((e for e in forward if e.edge_type == EdgeType.SEQUENTIAL), None)
        exc_edges = [e for e in forward if e.edge_type == EdgeType.EXCEPTION]
        finally_edges = [e for e in forward if e.edge_type not in (EdgeType.SEQUENTIAL, EdgeType.EXCEPTION)]

        body_block = self._visit(body_edge.target_id, visited, None) if body_edge else None

        handlers: list[tuple[GraphNode, Block | None]] = []
        for exc_edge in exc_edges:
            exc_node = self.cfg.get_node(exc_edge.target_id)
            if exc_node:
                exc_outgoing = [
                    e for e in self.cfg.get_outgoing_edges(exc_node.id)
                    if e.edge_type == EdgeType.SEQUENTIAL
                ]
                handler_body = None
                if exc_outgoing:
                    handler_body = self._visit(exc_outgoing[0].target_id, visited | {exc_node.id}, None)
                handlers.append((exc_node, handler_body))

        finally_block = None
        if finally_edges:
            fin_node = self.cfg.get_node(finally_edges[0].target_id)
            if fin_node:
                finally_block = self._visit(fin_node.id, visited, None)

        try_block = TryBlock(
            try_node=node,
            body=body_block,
            handlers=handlers,
            finally_block=finally_block,
        )

        # Find what comes after the try structure — look for nodes with multiple incoming edges
        all_try_exits = self._collect_exits_after_try(node.id, visited)
        after_id = self._find_merge_multi(all_try_exits, visited)
        after = self._visit(after_id, visited, stop_at) if after_id else None

        if after:
            return SequenceBlock([try_block, after])
        return try_block

    def _find_merge(self, left_id: str | None, right_id: str | None, visited: frozenset) -> str | None:
        if left_id is None or right_id is None:
            return None

        left_reach = self._reachable(left_id, visited)
        right_reach = self._reachable(right_id, visited)
        intersection = left_reach & right_reach

        if not intersection:
            return None

        best_id = None
        best_rank = len(self._topo) + 1
        for nid in intersection:
            rank = self._topo_index.get(nid, best_rank)
            if rank < best_rank:
                best_rank = rank
                best_id = nid
        return best_id

    def _find_merge_multi(self, node_ids: list[str], visited: frozenset) -> str | None:
        if not node_ids:
            return None
        if len(node_ids) == 1:
            return None
        combined = self._reachable(node_ids[0], visited)
        for nid in node_ids[1:]:
            combined &= self._reachable(nid, visited)
        if not combined:
            return None
        return min(combined, key=lambda x: self._topo_index.get(x, len(self._topo)))

    def _reachable(self, start_id: str, visited: frozenset) -> set[str]:
        result: set[str] = set()
        queue = deque([start_id])
        seen = {start_id} | visited
        while queue:
            nid = queue.popleft()
            result.add(nid)
            for edge in self.cfg.get_outgoing_edges(nid):
                if edge.edge_type in (EdgeType.LOOP_BACK,):
                    continue
                if edge.target_id not in seen:
                    seen.add(edge.target_id)
                    queue.append(edge.target_id)
        return result

    def _collect_exits_after_try(self, try_node_id: str, visited: frozenset) -> list[str]:
        reach = self._reachable(try_node_id, visited)
        exits = []
        for nid in reach:
            node = self.cfg.get_node(nid)
            if node and node.node_type in (NodeType.RETURN, NodeType.RAISE, NodeType.EXIT):
                exits.append(nid)
        return exits


def topo_sort(cfg: ControlFlowGraph) -> list[str]:
    in_degree: dict[str, int] = {n.id: 0 for n in cfg.nodes}
    adjacency: dict[str, list[str]] = {n.id: [] for n in cfg.nodes}

    for edge in cfg.edges:
        if edge.edge_type not in (EdgeType.LOOP_BACK,):
            if edge.target_id in in_degree:
                in_degree[edge.target_id] += 1
            if edge.source_id in adjacency:
                adjacency[edge.source_id].append(edge.target_id)

    queue: deque[str] = deque(nid for nid, deg in in_degree.items() if deg == 0)
    result: list[str] = []

    while queue:
        nid = queue.popleft()
        result.append(nid)
        for successor in adjacency.get(nid, []):
            in_degree[successor] -= 1
            if in_degree[successor] == 0:
                queue.append(successor)

    # Append any remaining nodes (cycles that weren't caught as LOOP_BACK)
    remaining = set(n.id for n in cfg.nodes) - set(result)
    result.extend(remaining)

    return result
