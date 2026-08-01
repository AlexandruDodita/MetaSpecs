"""Graph load/save routes, scoped to a project."""
from fastapi import APIRouter, HTTPException

from backend.models import LAYER_NAMES, LayerGraph
from backend.services import storage

router = APIRouter()


def _check_layer(layer: str) -> None:
    if layer not in LAYER_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown layer: {layer}")


def _check_project(project_id: str) -> None:
    if storage.read_project(project_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown project: {project_id}")


@router.get("/projects/{project_id}/graph/{layer}", response_model=LayerGraph)
def get_graph(project_id: str, layer: str) -> LayerGraph:
    _check_layer(layer)
    _check_project(project_id)
    return storage.read_graph(project_id, layer)


@router.post("/projects/{project_id}/graph/{layer}", response_model=LayerGraph)
def save_graph(project_id: str, layer: str, graph: LayerGraph) -> LayerGraph:
    _check_layer(layer)
    _check_project(project_id)
    return storage.write_graph(project_id, layer, graph)
