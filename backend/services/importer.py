"""Scan a local checkout into a project's graphs (see tools/import_repo.py)."""
from __future__ import annotations

from pathlib import Path

from backend.models import (
    LAYER_NAMES,
    ImportResult,
    ImportStats,
    LayerGraph,
    Project,
    now_utc,
)
from backend.services import storage
from tools import import_repo


class ProjectMissing(Exception):
    """Raised when the target project does not exist."""


class ImportPathError(Exception):
    """Raised when the requested path cannot be scanned."""


def import_into_project(project_id: str, raw_path: str, max_files: int) -> ImportResult:
    """Scan a local checkout and write its graphs into the project."""
    if not raw_path or not raw_path.strip():
        raise ImportPathError("path must not be empty")

    path = Path(raw_path).expanduser().resolve()
    if not path.exists():
        raise ImportPathError(f"no such directory: {path}")
    if not path.is_dir():
        raise ImportPathError(f"not a directory: {path}")
    if path.parent == path:
        raise ImportPathError("refusing to scan the filesystem root")

    # Check the project up front so an unknown id fails before the scan, then
    # re-read after it so a long scan can't clobber a concurrent edit.
    if storage.read_project(project_id) is None:
        raise ProjectMissing(project_id)

    data = import_repo.build(path, max_files or import_repo.DEFAULT_MAX_FILES)

    def _mutate(project: Project) -> None:
        # Only the server knows what the path resolves to, so a first import
        # names the project after the scanned root. A re-import keeps the name
        # the user has since given it.
        if not project.repo_path and not any(
            g.nodes for g in project.graphs.values()
        ):
            project.name = data.get("root") or project.name

        for layer in LAYER_NAMES:
            project.graphs[layer] = LayerGraph.model_validate(
                data["graphs"].get(layer, {})
            )
        project.repo_path = str(path)
        project.updated_at = now_utc()

    try:
        project = storage.update_project(project_id, _mutate)
    except storage.ProjectNotFound as exc:
        raise ProjectMissing(project_id) from exc

    return ImportResult(
        project_id=project_id,
        root=data.get("root", path.name),
        path=str(path),
        stats=ImportStats.model_validate(data.get("stats", {})),
        layers={layer: len(project.graphs[layer].nodes) for layer in LAYER_NAMES},
    )
