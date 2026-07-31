"""LLM validation route."""
from fastapi import APIRouter

from backend.models import ValidateRequest, ValidationReport
from backend.services import validate as validate_service

router = APIRouter()


@router.post("/validate", response_model=ValidationReport)
def validate(body: ValidateRequest) -> ValidationReport:
    return validate_service.validate(body.scope)
