"""Prune the stored graphs into the compact JSON sent to an LLM.

Layout keys, logic steps and `calls` arrays are pure noise to the model, so
this strips everything except the identity of each node/edge plus the
domain content: labels, paths, descriptions, notes, table columns, class
fields, and method signatures.
"""
from __future__ import annotations

import json
from typing import Any

from backend.models import LAYER_NAMES
from backend.services import storage


class GraphTooLargeError(Exception):
    """The pruned graph payload still exceeds what we will send to an LLM."""


MAX_PAYLOAD_CHARS = 300_000

NODE_KEYS = ("label", "path", "description", "notes")
EDGE_KEYS = ("kind", "label", "protocol")


def _signature(method: dict[str, Any]) -> str:
    visibility = method.get("visibility", "public")
    name = method.get("name", "")
    params = method.get("params", "")
    return_type = method.get("returnType", "")
    return f"{visibility} {name}({params}): {return_type}"


def _prune_node(node: Any) -> dict[str, Any]:
    data = node.data or {}
    entry: dict[str, Any] = {"id": node.id, "type": node.type}
    for key in NODE_KEYS:
        value = data.get(key)
        if value:
            entry[key] = value
    for key in ("columns", "fields"):
        value = data.get(key)
        if value:
            entry[key] = value
    methods = data.get("methods")
    if methods:
        entry["methods"] = [_signature(m) for m in methods]
    return entry


def _prune_edge(edge: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": edge.id,
        "source": edge.source,
        "target": edge.target,
    }
    for key in EDGE_KEYS:
        value = getattr(edge, key, None)
        if value:
            entry[key] = value
    return entry


def payload_for_llm(project_id: str) -> str:
    """Pruned, JSON-serialized graphs for all layers, ready for a prompt."""
    payload: dict[str, Any] = {}
    for layer in LAYER_NAMES:
        graph = storage.read_graph(project_id, layer)
        payload[layer] = {
            "nodes": [_prune_node(node) for node in graph.nodes],
            "edges": [_prune_edge(edge) for edge in graph.edges],
        }
    text = json.dumps(payload, sort_keys=True)
    if len(text) > MAX_PAYLOAD_CHARS:
        raise GraphTooLargeError(
            f"graph payload is {len(text):,} characters; the limit is "
            f"{MAX_PAYLOAD_CHARS:,}. Split the project or trim the graphs."
        )
    return text
