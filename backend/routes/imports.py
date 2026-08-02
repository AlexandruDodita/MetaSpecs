"""Repo import routes: scan a local checkout into a project, diff or rescan it."""
from fastapi import APIRouter, HTTPException

from backend.models import (
    DriftReport,
    DriftRequest,
    ImportRequest,
    ImportResult,
    ReimportRequest,
)
from backend.services import drift, importer
from tools import import_repo

router = APIRouter()

MAX_FILES_LIMIT = 20000


@router.post("/projects/{project_id}/import", response_model=ImportResult)
def import_repo_route(project_id: str, body: ImportRequest) -> ImportResult:
    max_files = min(max(body.max_files, 0), MAX_FILES_LIMIT)
    try:
        return importer.import_into_project(project_id, body.path, max_files)
    except importer.ProjectMissing as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except importer.ImportPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except import_repo.ScanLimitError as exc:
        raise HTTPException(status_code=413, detail=str(exc))


@router.post("/projects/{project_id}/reimport", response_model=ImportResult)
def reimport_route(project_id: str, body: ReimportRequest) -> ImportResult:
    max_files = min(max(body.max_files, 0), MAX_FILES_LIMIT)
    try:
        return importer.reimport_into_project(project_id, max_files)
    except importer.ProjectMissing as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except importer.ImportPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except import_repo.ScanLimitError as exc:
        raise HTTPException(status_code=413, detail=str(exc))


@router.post("/projects/{project_id}/drift", response_model=DriftReport)
def drift_route(project_id: str, body: DriftRequest) -> DriftReport:
    max_files = min(max(body.max_files, 0), MAX_FILES_LIMIT)
    try:
        return DriftReport(project_id=project_id, **drift.check_drift(project_id, max_files))
    except importer.ProjectMissing as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except importer.ImportPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except import_repo.ScanLimitError as exc:
        raise HTTPException(status_code=413, detail=str(exc))
