"""Graph load/save routes."""
from fastapi import APIRouter, HTTPException

from backend.models import LAYER_FILE, LayerGraph
from backend.services import storage

router = APIRouter()


def _check_layer(layer: str) -> None:
    if layer not in LAYER_FILE:
        raise HTTPException(status_code=404, detail=f"Unknown layer: {layer}")


@router.get("/graph/{layer}", response_model=LayerGraph)
def get_graph(layer: str) -> LayerGraph:
    _check_layer(layer)
    return storage.read_graph(layer)


@router.post("/graph/{layer}", response_model=LayerGraph)
def save_graph(layer: str, graph: LayerGraph) -> LayerGraph:
    _check_layer(layer)
    return storage.write_graph(layer, graph)
