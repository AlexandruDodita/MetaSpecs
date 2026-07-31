"""Flat JSON file IO for layer graphs and reports."""
from __future__ import annotations

import json
from pathlib import Path

from backend.models import LayerGraph, TaskList, ValidationReport

ROOT = Path(__file__).resolve().parents[2]


def _path(rel: str) -> Path:
    return ROOT / rel


def read_graph(layer: str) -> LayerGraph:
    path = _path(LAYER_FILE_PATH(layer))
    if not path.exists():
        return LayerGraph()
    return LayerGraph.model_validate(json.loads(path.read_text()))


def write_graph(layer: str, graph: LayerGraph) -> LayerGraph:
    path = _path(LAYER_FILE_PATH(layer))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(graph.model_dump(), indent=2))
    return graph


def read_validation() -> ValidationReport | None:
    path = _path(VALIDATION_FILE_PATH())
    if not path.exists():
        return None
    return ValidationReport.model_validate(json.loads(path.read_text()))


def write_validation(report: ValidationReport) -> None:
    path = _path(VALIDATION_FILE_PATH())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report.model_dump(), indent=2))


def read_tasks() -> TaskList | None:
    path = _path(TASKS_FILE_PATH())
    if not path.exists():
        return None
    return TaskList.model_validate(json.loads(path.read_text()))


def write_tasks(tasks: TaskList) -> None:
    path = _path(TASKS_FILE_PATH())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(tasks.model_dump(), indent=2, default=str))


def LAYER_FILE_PATH(layer: str) -> str:
    from backend.models import LAYER_FILE

    return LAYER_FILE[layer]


def VALIDATION_FILE_PATH() -> str:
    from backend.models import VALIDATION_FILE

    return VALIDATION_FILE


def TASKS_FILE_PATH() -> str:
    from backend.models import TASKS_FILE

    return TASKS_FILE
