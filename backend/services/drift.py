"""Drift check: compare stored graphs against a fresh scan of the repo.

READ-ONLY by design: a drift check never writes the graphs, because the stored
graph is the hand-edited spec that reality is being diffed against. Re-import
(see importer.reimport_into_project) is the destructive counterpart.
"""
from __future__ import annotations

from pathlib import Path

from backend.models import LAYER_NAMES, LayerGraph
from backend.services import importer, storage
from tools import diff_graphs, import_repo


def check_drift(project_id: str, max_files: int) -> dict:
    """Scan the project's repo path and diff it against the stored graphs."""
    project = storage.read_project(project_id)
    if project is None:
        raise importer.ProjectMissing(project_id)

    if not project.repo_path:
        raise importer.ImportPathError("this project was not imported from a codebase")

    path = Path(project.repo_path).expanduser().resolve()
    if not path.exists():
        raise importer.ImportPathError(f"no such directory: {path}")
    if not path.is_dir():
        raise importer.ImportPathError(f"not a directory: {path}")

    data = import_repo.build(path, max_files or import_repo.DEFAULT_MAX_FILES)

    old = {
        layer: project.graphs.get(layer, LayerGraph()).model_dump(mode="json")
        for layer in LAYER_NAMES
    }
    new = data["graphs"]
    report = diff_graphs.build_report(old, new, sorted(LAYER_NAMES), False)

    return {
        **report,
        "text": diff_graphs.render_text(report),
        "root": data["root"],
        "path": str(path),
        "stats": data["stats"],
    }
