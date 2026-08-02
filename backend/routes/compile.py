"""Compile route: graphs -> task list, scoped to a project."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from backend.models import CompileRequest, TaskList
from backend.services import storage
from backend.services import compile as compile_service
from backend.services.graph_payload import GraphTooLargeError
from backend.services.llm import LLMConfigError

router = APIRouter()


@router.post("/projects/{project_id}/compile", response_model=TaskList)
def compile_tasks(project_id: str, body: CompileRequest) -> TaskList:
    if storage.read_project(project_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown project: {project_id}")
    try:
        return compile_service.compile_tasks(project_id, body.scope)
    except LLMConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except GraphTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc


@router.get("/projects/{project_id}/tasks.json", response_model=None)
def export_tasks(project_id: str) -> JSONResponse:
    project = storage.read_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Unknown project: {project_id}")
    if project.tasks is None:
        raise HTTPException(
            status_code=404, detail="No compiled tasks yet — run Compile first."
        )
    return JSONResponse(
        content=project.tasks.model_dump(mode="json"),
        headers={"Content-Disposition": 'attachment; filename="tasks.json"'},
    )
