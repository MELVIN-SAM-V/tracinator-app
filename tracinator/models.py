from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum, auto


class NodeType(Enum):
    ENTRY = auto()
    EXIT = auto()
    STATEMENT = auto()
    IF = auto()
    ELIF = auto()
    ELSE = auto()
    FOR = auto()
    WHILE = auto()
    TRY = auto()
    EXCEPT = auto()
    FINALLY = auto()
    WITH = auto()
    CALL = auto()
    RETURN = auto()
    RAISE = auto()
    BREAK = auto()
    CONTINUE = auto()


class EdgeType(Enum):
    SEQUENTIAL = auto()
    TRUE = auto()
    FALSE = auto()
    EXCEPTION = auto()
    LOOP_BACK = auto()
    LOOP_EXIT = auto()


class VariableScope(Enum):
    GLOBAL = auto()
    STATE = auto()


@dataclass
class GraphNode:
    id: str
    node_type: NodeType
    label: str
    source_file: str
    start_line: int
    end_line: int
    raw_code: str = ""
    condition: str | None = None
    is_collapsed: bool = False
    called_function: str | None = None
    # 0-based index of this call among all CALL nodes sharing the same start_line
    # within this function, in evaluation order — e.g. `cat.speak() + dog.speak()`
    # both live on one line, so cat's call node is occurrence 0 and dog's is 1. The
    # trace's own call sites are keyed by (parent_frame_id, call_line) alone, so
    # this is what tells two same-line calls apart when resolving trace data.
    call_occurrence: int = 0
    sub_graph: ControlFlowGraph | None = None
    variable_refs: dict[str, list[str]] = field(default_factory=lambda: {"reads": [], "writes": []})
    call_args: list[str] = field(default_factory=list)
    assignments: dict[str, str] = field(default_factory=dict)


@dataclass
class GraphEdge:
    id: str
    source_id: str
    target_id: str
    edge_type: EdgeType
    label: str | None = None


@dataclass
class ControlFlowGraph:
    function_name: str
    qualified_name: str
    source_file: str
    start_line: int
    end_line: int
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    entry_node_id: str
    exit_node_ids: list[str]

    def get_node(self, node_id: str) -> GraphNode | None:
        for n in self.nodes:
            if n.id == node_id:
                return n
        return None

    def get_outgoing_edges(self, node_id: str) -> list[GraphEdge]:
        return [e for e in self.edges if e.source_id == node_id]

    def get_incoming_edges(self, node_id: str) -> list[GraphEdge]:
        return [e for e in self.edges if e.target_id == node_id]

    def all_paths(self) -> list[list[str]]:
        paths: list[list[str]] = []
        exit_set = set(self.exit_node_ids)

        def dfs(current: str, path: list[str], visited: set[str]) -> None:
            if len(paths) >= 1000:
                return
            if current in exit_set:
                paths.append(path + [current])
                return
            for edge in self.get_outgoing_edges(current):
                if edge.edge_type == EdgeType.LOOP_BACK:
                    continue
                if edge.target_id not in visited:
                    dfs(edge.target_id, path + [current], visited | {current})

        dfs(self.entry_node_id, [], set())
        return paths


@dataclass
class VariableInfo:
    name: str
    scope: VariableScope
    inferred_type: str | None
    assigned_at_lines: list[int] = field(default_factory=list)
    read_at_lines: list[int] = field(default_factory=list)
    is_parameter: bool = False
    initial_value: str | None = None
    param_index: int | None = None
    assignment_exprs: dict[int, str] = field(default_factory=dict)


class MethodKind(Enum):
    INSTANCE = auto()
    CLASSMETHOD = auto()
    STATICMETHOD = auto()


@dataclass
class FunctionSignature:
    name: str
    qualified_name: str
    source_file: str
    start_line: int
    parameters: list[str]          # unchanged meaning: full declared params incl. self/cls
    is_external: bool = False
    is_resolvable: bool = True
    class_name: str | None = None  # dotted, e.g. "Outer.Inner"; None for plain functions
    method_kind: MethodKind | None = None


@dataclass
class ImportResolution:
    import_statement: str
    resolved_file: str | None
    names: list[str]
    is_external: bool = False


@dataclass
class ProjectContext:
    project_root: str
    entry_file: str
    entry_function: str
    entry_qualified_name: str = ""
    all_graphs: dict[str, ControlFlowGraph] = field(default_factory=dict)
    all_signatures: dict[str, FunctionSignature] = field(default_factory=dict)
    import_map: dict[str, ImportResolution] = field(default_factory=dict)
    variables: dict[str, list[VariableInfo]] = field(default_factory=dict)
