"""Pydantic models for the MetaSpecs API."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

LAYER_FILE: dict[str, str] = {
    "backend": "data/backend.graph.json",
    "db": "data/db.schema.json",
    "frontend": "data/frontend.graph.json",
}

VALIDATION_FILE = "data/validation-report.json"
TASKS_FILE = "data/tasks.json"

LAYERS = Literal["backend", "db", "frontend"]
SEVERITY = Literal["error", "warning", "info"]


class GraphNode(BaseModel):
    id: str
    type: str = "table"
    position: dict[str, float]
    data: dict[str, Any] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    label: str = ""


class LayerGraph(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)


class ValidateRequest(BaseModel):
    scope: str


class Issue(BaseModel):
    node_id: str | None = None
    severity: SEVERITY = "warning"
    message: str


class ValidationReport(BaseModel):
    scope: str
    passed: bool
    issues: list[Issue] = Field(default_factory=list)


class Task(BaseModel):
    id: str
    title: str
    description: str = ""
    depends_on: list[str] = Field(default_factory=list)
    files: list[str] = Field(default_factory=list)


class TaskList(BaseModel):
    tasks: list[Task] = Field(default_factory=list)
    generated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class CompileRequest(BaseModel):
    scope: str
