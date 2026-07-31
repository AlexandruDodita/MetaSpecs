"""Compile route: graphs -> task list."""
from fastapi import APIRouter

from backend.models import CompileRequest, TaskList
from backend.services import compile as compile_service

router = APIRouter()


@router.post("/compile", response_model=TaskList)
def compile_tasks(body: CompileRequest) -> TaskList:
    return compile_service.compile_tasks(body.scope)
