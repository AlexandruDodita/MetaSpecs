"""Flat JSON file IO: one file per project under data/projects/.

A project file carries the `app: "metaspecs"` marker (see models.Project),
which is how projects are told apart from any other JSON in the directory.
"""
from __future__ import annotations

import json
import os
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path

from backend.models import (
    LAYER_NAMES,
    LayerGraph,
    Project,
    ProjectInfo,
    TaskList,
    ValidationReport,
    now_utc,
)

ROOT = Path(__file__).resolve().parents[2]
PROJECTS_DIR = ROOT / "data" / "projects"

LEGACY_GRAPH_FILES: dict[str, str] = {
    "backend": "data/backend.graph.json",
    "db": "data/db.schema.json",
    "frontend": "data/frontend.graph.json",
}


class ProjectNotFound(Exception):
    pass


_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _project_lock(project_id: str) -> threading.Lock:
    """One lock per project id; FastAPI runs sync routes in a threadpool."""
    with _locks_guard:
        lock = _locks.get(project_id)
        if lock is None:
            lock = threading.Lock()
            _locks[project_id] = lock
        return lock


def _atomic_write(path: Path, text: str) -> None:
    """Write via a temp file + os.replace so a crash can't truncate the file."""
    tmp = path.with_name(f"{path.name}.tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def project_path(project_id: str) -> Path:
    return PROJECTS_DIR / f"{project_id}.json"


def _read_raw(project_id: str) -> dict | None:
    path = project_path(project_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return data


def _ensure_migrated() -> None:
    """One-time import of pre-project graphs (data/backend.graph.json, …).

    Runs before listing so legacy files surface as an "Untitled" project
    instead of being stranded by the new per-project layout.
    """
    if any(PROJECTS_DIR.glob("*.json")):
        return
    legacy_paths = {layer: ROOT / rel for layer, rel in LEGACY_GRAPH_FILES.items()}
    if not any(p.exists() for p in legacy_paths.values()):
        return
    project = Project(
        id=_make_project_id(),
        name="Untitled",
        graphs={layer: LayerGraph() for layer in LAYER_NAMES},
    )
    for layer, path in legacy_paths.items():
        if not path.exists():
            continue
        try:
            project.graphs[layer] = LayerGraph.model_validate(json.loads(path.read_text()))
        except (OSError, ValueError):
            continue
    write_project(project)


def _make_project_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"p-{stamp}-{secrets.token_hex(3)}"


def list_projects() -> list[ProjectInfo]:
    """All recognized projects, newest first. Only files with our marker count."""
    _ensure_migrated()
    infos: list[ProjectInfo] = []
    for path in sorted(PROJECTS_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if data.get("app") != "metaspecs":
            continue
        try:
            project = Project.model_validate(data)
        except Exception:
            continue
        infos.append(project.info())
    infos.sort(key=lambda i: i.updated_at, reverse=True)
    return infos


def read_project(project_id: str) -> Project | None:
    data = _read_raw(project_id)
    if data is None or data.get("app") != "metaspecs":
        return None
    try:
        return Project.model_validate(data)
    except Exception:
        return None


def write_project(project: Project) -> Project:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    _atomic_write(
        project_path(project.id),
        json.dumps(project.model_dump(mode="json"), indent=2),
    )
    return project


def create_project(name: str) -> Project:
    _ensure_migrated()
    project = Project(id=_make_project_id(), name=name.strip() or "Untitled")
    return write_project(project)


def delete_project(project_id: str) -> bool:
    path = project_path(project_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def _require(project_id: str) -> Project:
    project = read_project(project_id)
    if project is None:
        raise ProjectNotFound(project_id)
    return project


def read_graph(project_id: str, layer: str) -> LayerGraph:
    return _require(project_id).graphs.get(layer, LayerGraph())


def write_graph(project_id: str, layer: str, graph: LayerGraph) -> LayerGraph:
    with _project_lock(project_id):
        project = _require(project_id)
        project.graphs[layer] = graph
        project.updated_at = now_utc()
        write_project(project)
    return graph


def write_validation(project_id: str, report: ValidationReport) -> None:
    with _project_lock(project_id):
        project = _require(project_id)
        project.validation = report
        write_project(project)


def write_tasks(project_id: str, tasks: TaskList) -> None:
    with _project_lock(project_id):
        project = _require(project_id)
        project.tasks = tasks
        write_project(project)


def write_scope(project_id: str, scope: str) -> None:
    with _project_lock(project_id):
        project = _require(project_id)
        if project.scope == scope:
            return
        project.scope = scope
        write_project(project)
