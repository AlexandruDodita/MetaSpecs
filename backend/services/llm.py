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


class LLMConfigError(RuntimeError):
    """models.yaml is missing a role or its API key."""


class RoleConfig(BaseModel):
    base_url: str
    model: str
    api_key: str
    # The api_key as written in models.yaml (e.g. "${OPENAI_API_KEY}"), kept so
    # a failed lookup can name the env var that didn't resolve.
    api_key_source: str = ""


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
            api_key_source=str(cfg.get("api_key", "")),
        )
        for name, cfg in roles.items()
    }


def _models_yaml_mtime() -> float:
    try:
        return os.path.getmtime(MODELS_YAML)
    except OSError:
        return 0.0


_cache: dict[str, tuple[instructor.Instructor, str]] = {}
_cache_mtime: float = 0.0


def _client(role: str) -> tuple[instructor.Instructor, str]:
    global _cache_mtime
    mtime = _models_yaml_mtime()
    if mtime != _cache_mtime:
        _cache.clear()
        _cache_mtime = mtime
    if role in _cache:
        return _cache[role]
    roles = _load_roles()
    cfg = roles.get(role)
    if cfg is None:
        defined = ", ".join(sorted(roles)) or "(none)"
        raise LLMConfigError(
            f"models.yaml has no role {role!r}; defined roles: {defined}"
        )
    if not cfg.api_key:
        raise LLMConfigError(
            f"API key for role {role!r} is empty (failed to resolve "
            f"{cfg.api_key_source!r} from the environment)"
        )
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
