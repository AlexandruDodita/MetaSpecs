"""Pydantic models for the MetaSpecs API."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

LAYERS = Literal["backend", "db", "frontend"]
LAYER_NAMES = ["backend", "db", "frontend"]
SEVERITY = Literal["error", "warning", "info"]

# React Flow UI state that must never be persisted.
TRANSIENT_FLOW_FIELDS = ("selected", "dragging", "resizing")

# Marker + schema version identifying a project file as ours ("metaspecs").
PROJECT_APP = "metaspecs"
PROJECT_VERSION = 1


class FlowElement(BaseModel):
    """Stored React Flow element: extras pass through, UI flags are dropped."""

    model_config = ConfigDict(extra="allow")

    @model_validator(mode="after")
    def _drop_transient(self):
        extra = self.__pydantic_extra__
        if extra:
            for key in TRANSIENT_FLOW_FIELDS:
                extra.pop(key, None)
        return self


class GraphNode(FlowElement):
    id: str
    type: str = "table"
    position: dict[str, float]
    data: dict[str, Any] = Field(default_factory=dict)


class GraphEdge(FlowElement):
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


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class CreateProjectRequest(BaseModel):
    name: str = "Untitled"


class ProjectInfo(BaseModel):
    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    node_count: int = 0


class ProjectList(BaseModel):
    projects: list[ProjectInfo] = Field(default_factory=list)


class ProjectReports(BaseModel):
    scope: str = ""
    validation: ValidationReport | None = None
    tasks: TaskList | None = None


class Project(BaseModel):
    """One file per project: `data/projects/<id>.json`.

    `app`/`version` are the format marker: only files carrying them are
    recognized as MetaSpecs projects when listing.
    """

    app: Literal["metaspecs"] = PROJECT_APP
    version: int = PROJECT_VERSION
    id: str
    name: str
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)
    scope: str = ""
    graphs: dict[str, LayerGraph] = Field(
        default_factory=lambda: {layer: LayerGraph() for layer in LAYER_NAMES}
    )
    validation: ValidationReport | None = None
    tasks: TaskList | None = None

    def info(self) -> ProjectInfo:
        node_count = sum(len(g.nodes) for g in self.graphs.values())
        return ProjectInfo(
            id=self.id,
            name=self.name,
            created_at=self.created_at,
            updated_at=self.updated_at,
            node_count=node_count,
        )

    def reports(self) -> ProjectReports:
        return ProjectReports(
            scope=self.scope,
            validation=self.validation,
            tasks=self.tasks,
        )
