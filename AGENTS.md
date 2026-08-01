# AGENTS.md

Visual Spec Builder: localhost visual editor for architecture specs. Users draw
three node-graph layouts (backend / db / frontend) on a canvas; an LLM pass
validates the graphs against a stated scope; a compile pass turns the graphs
into a scoped task list. Work is organized into **projects**: on first launch
the app shows a project picker (create/open/delete), each project lives in its
own file under `data/projects/`, and the last opened project id is remembered
in localStorage (`metaspecs.activeProjectId`).

Architecture decisions are final — do not re-litigate: React + Vite + TS with
@xyflow/react + Zustand; FastAPI backend; flat JSON files for storage (no DB);
single `uvicorn` process serves API + built frontend; no Docker/Tauri; no
agent-execution loop (MVP stops at tasks.json).

## Layout

- `backend/` — FastAPI. Entrypoint `backend/main.py` (`app`). Routes in
  `backend/routes/{projects,graph,validate,compile}.py`, each with its own
  `APIRouter`, mounted with prefix `/api`. Pydantic models in `backend/models.py`
  (incl. `Project`, `ProjectInfo`, `ProjectReports`). Services in
  `backend/services/`: `storage.py` (JSON file IO, one file per project),
  `llm.py` (OpenAI + instructor client), `validate.py`, `compile.py`.
- `frontend/` — Vite app (run everything with `npm --prefix frontend ...`).
  `src/types.ts` shared types; `src/store.ts` all Zustand graph state (active
  `project`, graphs, active layer, tools `select|rect|circle|table|wire`, live
  drag-to-draw rect, edit mode, selection); `src/nodeFactory.ts` node builders
  (default sizes, per-kind data); `src/api.ts` fetch helpers (all endpoints are
  project-scoped); `src/components/GraphCanvas.tsx` one `<ReactFlow>` per layer
  (drag-to-draw preview, context menus, wire tool, dark mode);
  `src/components/ProjectPicker.tsx` create/open/delete project screen (shown
  when `store.project` is null); `src/components/TableNode.tsx` table node
  (Oracle-style schema rows, one left/right handle pair per column) and
  `src/components/ShapeNode.tsx` generic shapes — rect (header + item list) and
  circle — both with edit mode (dropdowns/textarea, save/cancel/outside-click);
  `src/components/PreviewNode.tsx` dashed drag preview;
  `src/components/ClassNode.tsx` class object (fields + methods rows with
  visibility badges, TS-highlighted signatures; click a method to expand a
  nested sub-flow of logic nodes; edit form for label/fields/methods),
  `src/components/ServiceNode.tsx` service/controller container (expand to a
  nested sub-flow holding class nodes), `src/components/LogicNode.tsx` logic
  flow nodes (`start|end|step|branch|call`, inline label edit),
  `src/components/NestedFlow.tsx` generic nested `<ReactFlow>` mini-canvas
  (controlled, debounced writes, context menus, `NestedFlowContext` for inner
  node edits), `src/components/Highlighted.tsx` TS-like token highlighting +
  `VisibilityBadge` (from `src/highlight.ts` tokenizer; styles in
  `src/logic.css`); node types are `table|shape|class|service|logic|preview`,
  tools `select|rect|circle|table|class|service|wire` (class: backend+frontend
  layers, service: backend only);
  `src/components/ContextMenu.tsx` + `src/menu/` (OOP menu model:
  `MenuAction`/`MenuSubmenu`/`MenuSeparator`, builders per context in
  `builders.ts`); `src/components/Toolbar.tsx` left mini sidebar reusing the
  same store actions; `src/schema-options.ts` column type/constraint dropdown
  options.
- `data/` — runtime JSON, gitignored. One file per project:
  `data/projects/<project-id>.json`. Legacy pre-project files
  (`backend.graph.json` etc.) are imported once into an "Untitled" project by
  `storage._ensure_migrated()` on first `list_projects()` call.
- `mcp/` — MCP server exposing the whole app to LLM clients over stdio
  (`mcp/server.py`). Versions: MCP integration `0.1`, MetaSpecs project
  `v0.0.1`. It proxies the HTTP API (`METASPECS_API_URL`, default
  `http://localhost:8000`) with tools for project CRUD, graph read/write,
  node/wire editing, reports, validate and compile.
- `models.yaml` — LLM roles `orchestrator`/`worker`, each with `base_url`,
  `model`, `api_key` (may be `${ENV_VAR}`, resolved from environment).

## Commands

- Backend: `pip install -r requirements.txt`; run
  `uvicorn backend.main:app --reload --port 8000` from repo root (paths are
  cwd-relative).
- MCP server: `.venv/bin/python mcp/server.py` (stdio; requires the backend
  running). Do NOT use `python -m mcp.server` — the local `mcp/` directory
  would shadow the installed `mcp` package. Client config:
  `{"mcpServers": {"metaspecs": {"command": ".venv/bin/python", "args": ["mcp/server.py"]}}}`.
- Frontend dev: `npm --prefix frontend run dev` (port 5173, Vite proxies
  `/api` → :8000).
- Single-process serve: `npm --prefix frontend run build`, then uvicorn serves
  `frontend/dist` (main.py mounts it only if it exists).
- No test framework. Verify with `python -c` / FastAPI TestClient scripts
  (`httpx` is in requirements.txt for TestClient). Playwright (devDep in
  `frontend/`) is used for browser smoke tests.

## Contracts

Stored graph JSON is serializable React Flow v12 state:

```json
{"nodes": [{"id": "n-1", "type": "table", "position": {"x": 0, "y": 0},
  "data": {"label": "users", "columns": [{"name": "id", "type": "uuid", "constraint": "PRIMARY KEY"}]}}],
 "edges": [{"id": "e-1", "source": "n-1", "target": "n-2", "label": ""}]}
```

- Project files live at `data/projects/<id>.json`; the `app: "metaspecs"`
  marker (plus `version`) is what identifies a file as one of our projects —
  `list_projects()` ignores anything else in that directory.
- Project file shape: `{app, version, id, name, created_at, updated_at, scope,
  graphs: {backend, db, frontend}, validation, tasks}`. `scope` + the last
  validation report and task list are saved with the project and restored on
  open (`GET /api/projects/{id}/reports`).
- All API routes are project-scoped; the old unscoped routes
  (`/api/graph/{layer}` etc.) are gone (the SPA catch-all in `main.py` only
  serves `index.html` for non-API GETs).
- Layers are lowercase strings `backend|db|frontend`; unknown layer → 404.
- `Project` CRUD: `GET|POST /api/projects`, `GET|DELETE /api/projects/{id}`,
  `GET /api/projects/{id}/reports` → `ProjectReports`.
- `GET|POST /api/projects/{id}/graph/{layer}` → `LayerGraph` (POST echoes the
  saved graph); unknown project → 404.
- `POST /api/projects/{id}/validate` body `{"scope": str}` → `ValidationReport`
  (`scope`, `passed`, `issues[{node_id, severity: error|warning|info, message}]`);
  stored on the project.
- `POST /api/projects/{id}/compile` body `{"scope": str}` → `TaskList`
  (`tasks[{id, title, description, depends_on[], files[]}], generated_at`);
  stored on the project.
- All LLM calls go through `chat_json(role, system, user, response_model)` in
  `backend/services/llm.py` (instructor, strict JSON). Tests stub it by
  monkeypatching `chat_json` on the service module (`backend.services.validate`
  / `backend.services.compile`).

## Gotchas

- The app boots into `ProjectPicker` when `store.project` is null; on startup
  App resumes the id in `metaspecs.activeProjectId` (cleared on 404). All
  graph/validate/compile calls are project-scoped — `store.persist` and
  `store.loadAll` silently no-op without an active project, so the canvas is
  never rendered until one is open.
- Project file schema lives in `models.Project`; graphs are the
  `graphs` sub-object. Writing a graph bumps `updated_at`; validate/compile
  also persist `scope` into the project file (restored via `/reports`).
- `GraphNode.data` is Pydantic `dict[str, Any]`; the table shape lives in
  `src/types.ts` (`TableNodeData`) and the generic shape in `ShapeNodeData`
  (`kind: rect|circle`, `label`, `items[]`). Keep both in sync when changing.
- `constraint` is free-text (e.g. "PRIMARY KEY", "NOT NULL"), never an enum;
  the edit-mode dropdowns in `TableNode.tsx` are suggestions only.
- Placement tools (`rect|circle|table`) draw on drag: pane `mousedown`
  (native listener on `.react-flow__pane`, v12 has no `onPaneMouseDown` prop)
  → live `drawing` rect in the store → a `preview` node appended to the
  `nodes` prop (never persisted) → `mouseup` creates a sized node via
  `makeNode(kind, x, y, w, h)`; `style: {width, height}` holds the size.
- Node sizes persist via `NodeResizer onResizeEnd` → `updateNodeSize`
  (writes `node.style.width/height`); RF's own resize only sets
  `measured`/`width` which Pydantic would otherwise drop — the backend
  `extra="allow"` passthrough is what makes both survive a round-trip.
- Resize handles are always rendered (`isVisible` default) and revealed via
  CSS (`.react-flow__resize-control { opacity: 0 }` + `:hover`/`.selected`
  on `.react-flow__node`); sizes are in flow units — at zoom≠1 a screen-space
  drag maps through the current viewport.
- Auto-fit runs only for a loaded, untouched graph (`!dirty`), never after a
  user edit, so drag-to-draw coordinates stay deterministic.
- All graph mutation flows through Zustand actions in `src/store.ts` using
  `applyNodeChanges`/`applyEdgeChanges`; cast changes/nodes/edges to React Flow
  `NodeChange[]`/`Node[]` at that boundary (`as unknown as ...` where TS
  disagrees).
- `nodeTypes = { table: TableNode, shape: ShapeNode, class: ClassNode,
  service: ServiceNode, preview: PreviewNode }`;
  the custom node reads `activeLayer` from the store so its actions target
  the right layer.
- Nested sub-flows: `ClassNode` methods and `ServiceNode` bodies render a
  second `<ReactFlow>` via `NestedFlow`. Nested graphs live in node data
  (`Method.flow` / `ServiceNodeData.flow`), written back through
  `saveMethodFlow`/`saveServiceFlow` (store) or `NestedFlowContext` for
  inner-node edits; `NestedFlow` debounces `onChange` 400ms and flushes
  before opening its context menus (otherwise a pending debounce can
  overwrite a menu commit). Expansion is UI-only store state
  (`expanded`/`expandedMethod`), never persisted. The wrapper div carries
  `data-subflow` — GraphCanvas's global hotkeys bail out when the pointer is
  inside one.
- `ClassNode`/`ServiceNode`/`LogicNode` read their data from React Flow's
  `data` prop (they render inside sub-flows where store lookups would miss);
  top-level edit forms still use the store draft machinery.
- Table edit state lives in the store (`editingNodeId`/`editDraft`), NOT in
  node data — the stored graph JSON must stay serializable.
- Clicks inside the edit form must `stopPropagation()` or React Flow's
  `onNodeClick` will commit+close the form mid-edit.
- Tool hotkeys V/R/C/T/K/S/W are bound in `GraphCanvas` (ignored while typing
  in inputs and inside `[data-subflow]`); edges get labels via right-click →
  "Label edge…".
- `<ReactFlow colorMode="dark">` handles controls/minimap theming; extra dark
  overrides live in `src/index.css`.
