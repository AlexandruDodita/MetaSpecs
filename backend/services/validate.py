"""LLM validation pass: check the three graphs against the stated scope."""
from __future__ import annotations

from backend.models import Issue, ValidationReport
from backend.services import storage
from backend.services.llm import chat_json


def _graph_payload() -> dict:
    return {
        "backend": storage.read_graph("backend").model_dump(),
        "db": storage.read_graph("db").model_dump(),
        "frontend": storage.read_graph("frontend").model_dump(),
    }


SYSTEM_PROMPT = (
    "You are a strict architecture reviewer. You validate node graphs against "
    "a stated product scope. Report only concrete, actionable issues tied to "
    "specific nodes. Never invent requirements that are absent from the scope."
)


def validate(scope: str) -> ValidationReport:
    payload = _graph_payload()
    report = chat_json(
        "orchestrator",
        SYSTEM_PROMPT,
        f"""Scope:
{scope}

Architecture graphs (backend / db / frontend), each as React Flow state with
table nodes carrying a "columns" array of {{name, type, constraint}}:
{payload}

Check: scope coverage (is everything in the scope represented?), consistency
across layers (do backend tables/endpoints match db schema and frontend
features?), and obvious modeling errors (missing primary keys, dangling edges,
invalid references).

Return a report with issues: each issue has node_id (optional), severity
(error|warning|info), and message. Set passed=false if any error exists.""",
        ValidationReport,
    )
    storage.write_validation(report)
    return report
