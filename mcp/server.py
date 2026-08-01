"""MetaSpecs MCP server — expose the Visual Spec Builder to LLM clients.

Runs over stdio and proxies the MetaSpecs HTTP API (FastAPI on
`METASPECS_API_URL`, default `http://localhost:8000`), so the backend must
be running. It talks to a flat set of tools covering project CRUD, graph
reads/writes, node and wire editing, and the validate/compile analysis
passes.

Versions: MCP integration is version 0.1; the MetaSpecs project itself is
version 0.0.1. Both are exposed via the `server_info` tool.

Run (stdio, from the repo root, backend already running):
    .venv/bin/python mcp/server.py

NOTE: do not use `python -m mcp.server` — the local `mcp/` directory would
shadow the installed `mcp` package.
"""
from __future__ import annotations

import os
import uuid
from typing import Any

import httpx

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

MCP_VERSION = "0.1"
PROJECT_VERSION = "0.0.1"
API_URL = os.environ.get("METASPECS_API_URL", "http://localhost:8000")
LAYERS = ("backend", "db", "frontend")
# Persistable node types; 'preview' is the transient drag ghost and never stored.
NODE_TYPES = ("table", "shape", "class", "service")
# Mirrors EDGE_KIND_NAMES in backend/models.py; the repo root isn't importable from here.
EDGE_KINDS = ("contains", "calls", "implements", "reads", "writes", "depends-on")

# Mirrors DEFAULT_SIZE in frontend/src/nodeFactory.ts — keep the two in sync.
DEFAULT_SIZE: dict[str, dict[str, float]] = {
    "table": {"width": 260, "height": 150},
    "shape": {"width": 180, "height": 110},
    "class": {"width": 260, "height": 180},
    "service": {"width": 320, "height": 240},
}

server = MCPServer("metaspecs", version=MCP_VERSION)
_client = httpx.Client(base_url=API_URL, timeout=120.0)


def _json(method: str, path: str, **kwargs: Any) -> Any:
    try:
        resp = _client.request(method, path, **kwargs)
    except httpx.HTTPError as exc:
        raise ToolError(f"MetaSpecs backend unreachable at {API_URL}: {exc}") from exc
    if resp.status_code >= 400:
        raise ToolError(f"MetaSpecs API {resp.status_code}: {resp.text}")
    if resp.status_code == 204:
        return None
    return resp.json()


def _check_layer(layer: str) -> None:
    if layer not in LAYERS:
        raise ToolError(f"Unknown layer '{layer}'; use one of: {', '.join(LAYERS)}")


def _graph(project_id: str, layer: str) -> dict:
    return _json("GET", f"/api/projects/{project_id}/graph/{layer}")


def _save_graph(project_id: str, layer: str, graph: dict) -> dict:
    return _json("POST", f"/api/projects/{project_id}/graph/{layer}", json=graph)


def _mutate(project_id: str, layer: str, fn) -> dict:
    _check_layer(layer)
    graph = _graph(project_id, layer)
    state: dict = {}
    fn(graph, state)
    saved = _save_graph(project_id, layer, graph)
    return {
        "project_id": project_id,
        "layer": layer,
        "nodes": len(saved["nodes"]),
        "edges": len(saved["edges"]),
        **state,
    }


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


@server.tool(
    description=(
        "Server information: MCP integration version (0.1), MetaSpecs "
        "project version (0.0.1), backend URL, layers and available tools."
    )
)
async def server_info() -> dict:
    return {
        "name": "metaspecs",
        "mcp_version": MCP_VERSION,
        "project_version": PROJECT_VERSION,
        "backend_url": API_URL,
        "layers": list(LAYERS),
        "node_types": list(NODE_TYPES),
        "edge_kinds": list(EDGE_KINDS),
        "tools": sorted(t.name for t in await server.list_tools()),
    }


@server.tool(
    description=(
        "List all MetaSpecs projects: id, name, created/updated timestamps "
        "and total node count per project."
    )
)
def list_projects() -> dict:
    return _json("GET", "/api/projects")


@server.tool(description="Create a new project and return its info (id, name, timestamps).")
def create_project(name: str = "Untitled") -> dict:
    return _json("POST", "/api/projects", json={"name": name})


@server.tool(
    description=(
        "Get a project's summary: info, scope, last validation report, last "
        "task list and per-layer node/edge counts. Use get_graph for the "
        "full node/edge detail of a layer."
    )
)
def get_project(project_id: str) -> dict:
    info = _json("GET", f"/api/projects/{project_id}")
    reports = _json("GET", f"/api/projects/{project_id}/reports")
    graphs = {}
    for layer in LAYERS:
        g = _graph(project_id, layer)
        graphs[layer] = {"nodes": len(g["nodes"]), "edges": len(g["edges"])}
    return {**info, **reports, "graphs": graphs}


@server.tool(description="Delete a project and all of its graphs, reports and tasks.")
def delete_project(project_id: str) -> str:
    _json("DELETE", f"/api/projects/{project_id}")
    return f"Deleted project {project_id}"


@server.tool(
    description=(
        "Read the full React Flow graph (nodes + edges) of one layer "
        "(backend|db|frontend). Node shape: {id, type, position:{x,y}, "
        "data}. Edge shape: {id, source, target, label}."
    )
)
def get_graph(project_id: str, layer: str) -> dict:
    _check_layer(layer)
    return _graph(project_id, layer)


@server.tool(
    description=(
        "Replace an entire layer graph. nodes: [{id, type: table|shape|"
        "class|service, position:{x,y}, data}], edges: [{id, source, "
        "target, label}]. A service's membership travels in edges: any "
        "class wired to a service node belongs to it."
    )
)
def save_graph(project_id: str, layer: str, nodes: list[dict], edges: list[dict]) -> dict:
    _check_layer(layer)
    return _save_graph(project_id, layer, {"nodes": nodes, "edges": edges})


@server.tool(
    description=(
        "Add a node to a layer graph. data by type — "
        "table: {label, columns: [{name, type, constraint}]}, constraint is "
        "free text like 'PRIMARY KEY', never an enum. "
        "shape: {kind: 'rect'|'circle', label, items: [string]}. "
        "class: {label, fields: [{name, visibility, type}], methods: [{id, "
        "name, visibility, returnType, params, steps: [{id, kind, label}]}]}, "
        "visibility is public|private|protected, step kind is "
        "step|branch|call, ids unique within the node. "
        "service: {label} only — members are NOT in its data, wire a class to "
        "it with add_edge (either direction). "
        "Layers, as in the UI: class is backend+frontend, service is backend, "
        "table and shape are any. path/description are optional node metadata "
        "merged into data. Returns the new node id and graph counts."
    )
)
def add_node(
    project_id: str,
    layer: str,
    type: str,
    x: float,
    y: float,
    id: str | None = None,
    data: dict | None = None,
    width: float | None = None,
    height: float | None = None,
    path: str = "",
    description: str = "",
) -> dict:
    if type not in NODE_TYPES:
        raise ToolError(f"type must be one of: {', '.join(NODE_TYPES)}")
    node_id = id or _new_id("n")
    # A circle is 120x120 in the UI, unlike the rect-sized 'shape' default.
    default = DEFAULT_SIZE[type]
    if type == "shape" and (data or {}).get("kind") == "circle":
        default = {"width": 120, "height": 120}
    style = {
        "width": width if width is not None else default["width"],
        "height": height if height is not None else default["height"],
    }
    node_data = dict(data or {})
    if path and "path" not in node_data:
        node_data["path"] = path
    if description and "description" not in node_data:
        node_data["description"] = description

    def fn(graph: dict, state: dict) -> None:
        if any(n["id"] == node_id for n in graph["nodes"]):
            raise ToolError(f"Node {node_id} already exists on layer {layer}")
        node: dict = {
            "id": node_id,
            "type": type,
            "position": {"x": x, "y": y},
            "data": node_data,
            "style": style,
        }
        graph["nodes"].append(node)
        state["id"] = node_id
        state["node"] = node

    return _mutate(project_id, layer, fn)


@server.tool(
    description=(
        "Update an existing node: position {x, y} replaces coordinates, "
        "data is merged into the node's existing data (e.g. new columns "
        "for a table). Returns the updated node."
    )
)
def update_node(
    project_id: str,
    layer: str,
    id: str,
    position: dict | None = None,
    data: dict | None = None,
) -> dict:
    def fn(graph: dict, state: dict) -> None:
        node = next((n for n in graph["nodes"] if n["id"] == id), None)
        if node is None:
            raise ToolError(f"No node {id} on layer {layer}")
        if position is not None:
            node["position"] = {**node["position"], **position}
        if data is not None:
            node["data"] = {**node["data"], **data}
        state["node"] = node

    return _mutate(project_id, layer, fn)


@server.tool(
    description=(
        "Remove a node from a layer graph, along with every edge connected "
        "to it. Returns the number of edges removed as a side effect."
    )
)
def remove_node(project_id: str, layer: str, id: str) -> dict:
    def fn(graph: dict, state: dict) -> None:
        if not any(n["id"] == id for n in graph["nodes"]):
            raise ToolError(f"No node {id} on layer {layer}")
        graph["nodes"] = [n for n in graph["nodes"] if n["id"] != id]
        before = len(graph["edges"])
        graph["edges"] = [e for e in graph["edges"] if e["source"] != id and e["target"] != id]
        state["removed_edges"] = before - len(graph["edges"])

    return _mutate(project_id, layer, fn)


@server.tool(
    description=(
        "Wire two nodes on a layer: add an edge from source node id to "
        "target node id, with an optional label, kind and protocol. kind is "
        "one of contains|calls|implements|reads|writes|depends-on (default "
        "depends-on). Both nodes must already exist. Returns the new edge id "
        "and the resulting graph counts."
    )
)
def add_edge(
    project_id: str,
    layer: str,
    source: str,
    target: str,
    id: str | None = None,
    label: str = "",
    kind: str = "depends-on",
    protocol: str = "",
) -> dict:
    if kind not in EDGE_KINDS:
        raise ToolError(f"kind must be one of: {', '.join(EDGE_KINDS)}")
    edge_id = id or _new_id("e")

    def fn(graph: dict, state: dict) -> None:
        ids = {n["id"] for n in graph["nodes"]}
        if source not in ids:
            raise ToolError(f"No node {source} on layer {layer}")
        if target not in ids:
            raise ToolError(f"No node {target} on layer {layer}")
        if any(e["id"] == edge_id for e in graph["edges"]):
            raise ToolError(f"Edge {edge_id} already exists on layer {layer}")
        edge = {
            "id": edge_id,
            "source": source,
            "target": target,
            "label": label,
            "kind": kind,
            "protocol": protocol,
        }
        graph["edges"].append(edge)
        state["id"] = edge_id
        state["edge"] = edge

    return _mutate(project_id, layer, fn)


@server.tool(
    description="Set (or clear, with empty string) the label of an existing edge."
)
def set_edge_label(project_id: str, layer: str, id: str, label: str) -> dict:
    def fn(graph: dict, state: dict) -> None:
        edge = next((e for e in graph["edges"] if e["id"] == id), None)
        if edge is None:
            raise ToolError(f"No edge {id} on layer {layer}")
        edge["label"] = label
        state["edge"] = edge

    return _mutate(project_id, layer, fn)


@server.tool(
    description=(
        "Set the kind of an existing edge, one of contains|calls|implements|"
        "reads|writes|depends-on, with an optional protocol string."
    )
)
def set_edge_kind(project_id: str, layer: str, id: str, kind: str, protocol: str | None = None) -> dict:
    if kind not in EDGE_KINDS:
        raise ToolError(f"kind must be one of: {', '.join(EDGE_KINDS)}")

    def fn(graph: dict, state: dict) -> None:
        edge = next((e for e in graph["edges"] if e["id"] == id), None)
        if edge is None:
            raise ToolError(f"No edge {id} on layer {layer}")
        edge["kind"] = kind
        if protocol is not None:  # omitting it must not wipe the existing value
            edge["protocol"] = protocol
        state["edge"] = edge

    return _mutate(project_id, layer, fn)


@server.tool(description="Remove an edge from a layer graph by its id.")
def remove_edge(project_id: str, layer: str, id: str) -> dict:
    def fn(graph: dict, state: dict) -> None:
        if not any(e["id"] == id for e in graph["edges"]):
            raise ToolError(f"No edge {id} on layer {layer}")
        graph["edges"] = [e for e in graph["edges"] if e["id"] != id]

    return _mutate(project_id, layer, fn)


@server.tool(
    description=(
        "Get a project's saved reports: scope, last validation report and "
        "last compiled task list."
    )
)
def get_reports(project_id: str) -> dict:
    return _json("GET", f"/api/projects/{project_id}/reports")


@server.tool(
    description=(
        "Validate the three layer graphs against a stated scope. Runs the "
        "backend LLM pass; returns {scope, passed, issues[{node_id, "
        "severity, message}]} and stores the report on the project."
    )
)
def validate_project(project_id: str, scope: str) -> dict:
    return _json("POST", f"/api/projects/{project_id}/validate", json={"scope": scope})


@server.tool(
    description=(
        "Compile the three layer graphs into a scoped task list. Runs the "
        "backend LLM pass; returns {tasks: [{id, title, description, "
        "depends_on, files}], generated_at} and stores it on the project."
    )
)
def compile_project(project_id: str, scope: str) -> dict:
    return _json("POST", f"/api/projects/{project_id}/compile", json={"scope": scope})


if __name__ == "__main__":
    server.run()
