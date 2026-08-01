"""LLM validation route, scoped to a project."""
from fastapi import APIRouter, HTTPException

from backend.models import ValidateRequest, ValidationReport
from backend.services import storage
from backend.services import validate as validate_service
from backend.services.llm import LLMConfigError

router = APIRouter()


@router.post("/projects/{project_id}/validate", response_model=ValidationReport)
def validate(project_id: str, body: ValidateRequest) -> ValidationReport:
    if storage.read_project(project_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown project: {project_id}")
    try:
        return validate_service.validate(project_id, body.scope)
    except LLMConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
