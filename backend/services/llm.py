"""LLM wiring: named roles from models.yaml, strict-JSON via instructor."""
from __future__ import annotations

import os
from typing import Any, TypeVar

import instructor
import yaml
from openai import OpenAI
from pydantic import BaseModel

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODELS_YAML = os.path.join(ROOT, "models.yaml")

T = TypeVar("T", bound=BaseModel)


class RoleConfig(BaseModel):
    base_url: str
    model: str
    api_key: str


def _resolve_api_key(value: str) -> str:
    value = value.strip()
    if value.startswith("${") and value.endswith("}"):
        env_name = value[2:-1]
        return os.environ.get(env_name, "")
    return value


def _load_roles() -> dict[str, RoleConfig]:
    with open(MODELS_YAML) as f:
        raw = yaml.safe_load(f) or {}
    roles = raw.get("roles", {})
    return {
        name: RoleConfig(
            base_url=cfg["base_url"],
            model=cfg["model"],
            api_key=_resolve_api_key(cfg.get("api_key", "")),
        )
        for name, cfg in roles.items()
    }


_cache: dict[str, tuple[instructor.Instructor, str]] = {}


def _client(role: str) -> tuple[instructor.Instructor, str]:
    if role in _cache:
        return _cache[role]
    cfg = _load_roles()[role]
    client = instructor.from_openai(
        OpenAI(base_url=cfg.base_url, api_key=cfg.api_key)
    )
    _cache[role] = (client, cfg.model)
    return _cache[role]


def chat_json(role: str, system: str, user: str, response_model: type[T]) -> T:
    """Call the LLM for a role and return a strict-JSON-validated model."""
    client, model = _client(role)
    return client.chat.completions.create(
        model=model,
        response_model=response_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
