"""Graph load/save routes, scoped to a project."""
from fastapi import APIRouter, HTTPException

from backend.models import LAYER_NAMES, NODE_TYPE_NAMES, LayerGraph
from backend.services import storage

router = APIRouter()


def _check_layer(layer: str) -> None:
    if layer not in LAYER_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown layer: {layer}")


def _check_project(project_id: str) -> None:
    if storage.read_project(project_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown project: {project_id}")


def check_graph_integrity(graph: LayerGraph) -> list[str]:
    """Human-readable structural problems with a graph, capped at 10."""
    problems: list[str] = []

    seen_node_ids: set[str] = set()
    for node in graph.nodes:
        if node.id in seen_node_ids:
            problems.append(f"duplicate node id: {node.id}")
        seen_node_ids.add(node.id)
        if node.type not in NODE_TYPE_NAMES:
            problems.append(f"node {node.id} has unknown type: {node.type}")

    node_ids = seen_node_ids
    seen_edge_ids: set[str] = set()
    for edge in graph.edges:
        if edge.id in seen_edge_ids:
            problems.append(f"duplicate edge id: {edge.id}")
        seen_edge_ids.add(edge.id)
        for endpoint, name in ((edge.source, "source"), (edge.target, "target")):
            if endpoint not in node_ids:
                problems.append(
                    f"edge {edge.id} references missing {name} node: {endpoint}"
                )

    total = len(problems)
    if total > 10:
        problems = problems[:10]
        problems.append(f"… and {total - 10} more")
    return problems


@router.get("/projects/{project_id}/graph/{layer}", response_model=LayerGraph)
def get_graph(project_id: str, layer: str) -> LayerGraph:
    _check_layer(layer)
    _check_project(project_id)
    return storage.read_graph(project_id, layer)


@router.post("/projects/{project_id}/graph/{layer}", response_model=LayerGraph)
def save_graph(project_id: str, layer: str, graph: LayerGraph) -> LayerGraph:
    _check_layer(layer)
    _check_project(project_id)
    problems = check_graph_integrity(graph)
    if problems:
        raise HTTPException(status_code=400, detail="; ".join(problems))
    return storage.write_graph(project_id, layer, graph)
