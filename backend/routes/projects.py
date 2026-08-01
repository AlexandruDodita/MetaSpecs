"""Project CRUD routes."""
from fastapi import APIRouter, HTTPException

from backend.models import (
    CreateProjectRequest,
    ProjectInfo,
    ProjectList,
    ProjectReports,
)
from backend.services import storage

router = APIRouter()


def _get_project(project_id: str):
    project = storage.read_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Unknown project: {project_id}")
    return project


@router.get("/projects", response_model=ProjectList)
def list_projects() -> ProjectList:
    return ProjectList(projects=storage.list_projects())


@router.post("/projects", response_model=ProjectInfo, status_code=201)
def create_project(body: CreateProjectRequest) -> ProjectInfo:
    return storage.create_project(body.name).info()


@router.get("/projects/{project_id}", response_model=ProjectInfo)
def get_project(project_id: str) -> ProjectInfo:
    return _get_project(project_id).info()


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str) -> None:
    if not storage.delete_project(project_id):
        raise HTTPException(status_code=404, detail=f"Unknown project: {project_id}")


@router.get("/projects/{project_id}/reports", response_model=ProjectReports)
def get_reports(project_id: str) -> ProjectReports:
    return _get_project(project_id).reports()
