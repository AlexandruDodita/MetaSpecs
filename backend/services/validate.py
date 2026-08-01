"""LLM validation pass: check the three graphs against the stated scope."""
from __future__ import annotations

from backend.models import LAYER_NAMES, Issue, ValidationReport
from backend.services import storage
from backend.services.llm import chat_json


def _graph_payload(project_id: str) -> dict:
    return {
        layer: storage.read_graph(project_id, layer).model_dump()
        for layer in LAYER_NAMES
    }


SYSTEM_PROMPT = (
    "You are a strict architecture reviewer. You validate node graphs against "
    "a stated product scope. Report only concrete, actionable issues tied to "
    "specific nodes. Never invent requirements that are absent from the scope."
)


def validate(project_id: str, scope: str) -> ValidationReport:
    payload = _graph_payload(project_id)
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
    storage.write_scope(project_id, scope)
    storage.write_validation(project_id, report)
    return report
