"""Compile pass: turn the graphs into a scoped task list for coding agents."""
from __future__ import annotations

from backend.models import Task, TaskList
from backend.services import storage
from backend.services.llm import chat_json


def _graph_payload() -> dict:
    return {
        "backend": storage.read_graph("backend").model_dump(),
        "db": storage.read_graph("db").model_dump(),
        "frontend": storage.read_graph("frontend").model_dump(),
    }


SYSTEM_PROMPT = (
    "You are a senior engineering planner. You turn architecture graphs into a "
    "scoped, dependency-ordered task list for downstream coding agents. Tasks "
    "must be concrete, independently executable, and reference the files they "
    "touch. Order by dependency: schema before backend before frontend where "
    "applicable."
)


def compile_tasks(scope: str) -> TaskList:
    payload = _graph_payload()
    tasks = chat_json(
        "orchestrator",
        SYSTEM_PROMPT,
        f"""Scope:
{scope}

Architecture graphs (backend / db / frontend), each as React Flow state with
table nodes carrying a "columns" array of {{name, type, constraint}} and edges
between nodes:
{payload}

Produce a task list implementing this scope. Each task: id (t1, t2, ...),
title, description (what to build, referencing graph nodes), depends_on (task
ids that must be done first), files (paths this task creates/modifies).""",
        TaskList,
    )
    id_map = {task.id: f"t{index}" for index, task in enumerate(tasks.tasks, start=1)}
    for index, task in enumerate(tasks.tasks, start=1):
        task.id = id_map[task.id]
        task.depends_on = [id_map.get(dep, dep) for dep in task.depends_on]
        if not task.files:
            task.files = infer_files(task)
    storage.write_tasks(tasks)
    return tasks


def infer_files(task: Task) -> list[str]:
    """Best-effort default file hints when the LLM returns none."""
    title = task.title.lower()
    if "schema" in title or "table" in title or "migration" in title:
        return ["data/db.schema.json"]
    if "api" in title or "endpoint" in title or "backend" in title:
        return ["backend/"]
    if "frontend" in title or "page" in title or "ui" in title or "component" in title:
        return ["frontend/src/"]
    return ["."]
