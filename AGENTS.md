# AGENTS.md

Visual Spec Builder: localhost visual editor for architecture specs. Users draw
three node-graph layouts (backend / db / frontend) on a canvas; an LLM pass
validates the graphs against a stated scope; a compile pass turns the graphs
into a scoped task list written to `data/tasks.json`.

Architecture decisions are final — do not re-litigate: React + Vite + TS with
@xyflow/react + Zustand; FastAPI backend; flat JSON files for storage (no DB);
single `uvicorn` process serves API + built frontend; no Docker/Tauri; no
agent-execution loop (MVP stops at tasks.json).

## Layout

- `backend/` — FastAPI. Entrypoint `backend/main.py` (`app`). Routes in
  `backend/routes/{graph,validate,compile}.py`, each with its own `APIRouter`,
  mounted with prefix `/api`. Pydantic models in `backend/models.py`. Services
  in `backend/services/`: `storage.py` (JSON file IO), `llm.py` (OpenAI +
  instructor client), `validate.py`, `compile.py`.
- `frontend/` — Vite app (run everything with `npm --prefix frontend ...`).
  `src/types.ts` shared types; `src/store.ts` all Zustand graph state (graphs,
  active layer, tools `select|rect|circle|table|wire`, live drag-to-draw rect,
  edit mode, selection); `src/nodeFactory.ts` node builders (default sizes,
  per-kind data); `src/api.ts` fetch helpers; `src/components/GraphCanvas.tsx`
  one `<ReactFlow>` per layer (drag-to-draw preview, context menus, wire tool,
  dark mode); `src/components/TableNode.tsx` table node (Oracle-style schema
  rows, one left/right handle pair per column) and `src/components/ShapeNode.tsx`
  generic shapes — rect (header + item list) and circle — both with edit mode
  (dropdowns/textarea, save/cancel/outside-click); `src/components/PreviewNode.tsx`
  dashed drag preview; `src/components/ContextMenu.tsx` + `src/menu/` (OOP menu
  model: `MenuAction`/`MenuSubmenu`/`MenuSeparator`, builders per context in
  `builders.ts`); `src/components/Toolbar.tsx` left mini sidebar reusing the
  same store actions; `src/schema-options.ts` column type/constraint dropdown
  options.
- `data/` — runtime JSON, gitignored: `backend.graph.json`, `db.schema.json`,
  `frontend.graph.json`, `validation-report.json`, `tasks.json`.
- `models.yaml` — LLM roles `orchestrator`/`worker`, each with `base_url`,
  `model`, `api_key` (may be `${ENV_VAR}`, resolved from environment).

## Commands

- Backend: `pip install -r requirements.txt`; run
  `uvicorn backend.main:app --reload --port 8000` from repo root (paths are
  cwd-relative).
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

- Layers are lowercase strings `backend|db|frontend`; file map lives in
  `backend/models.py` `LAYER_FILE`: backend→`data/backend.graph.json`,
  db→`data/db.schema.json`, frontend→`data/frontend.graph.json`. Missing files
  read as empty graphs; unknown layer → 404.
- `GraphNode`/`GraphEdge` use `ConfigDict(extra="allow")` — full React Flow
  node/edge state (style, measured, markers, label style…) round-trips as-is.
- `GET|POST /api/graph/{layer}` → `LayerGraph` (POST echoes the saved graph).
- `POST /api/validate` body `{"scope": str}` → `ValidationReport`
  (`scope`, `passed`, `issues[{node_id, severity: error|warning|info, message}]`);
  writes `data/validation-report.json`.
- `POST /api/compile` body `{"scope": str}` → `TaskList`
  (`tasks[{id, title, description, depends_on[], files[]}], generated_at`);
  writes `data/tasks.json`.
- All LLM calls go through `chat_json(role, system, user, response_model)` in
  `backend/services/llm.py` (instructor, strict JSON). Tests stub it by
  monkeypatching `chat_json` on the service module (`backend.services.validate`
  / `backend.services.compile`).

## Gotchas

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
- `nodeTypes = { table: TableNode, shape: ShapeNode, preview: PreviewNode }`;
  the custom node reads `activeLayer` from the store so its actions target
  the right layer.
- Table edit state lives in the store (`editingNodeId`/`editDraft`), NOT in
  node data — the stored graph JSON must stay serializable.
- Clicks inside the edit form must `stopPropagation()` or React Flow's
  `onNodeClick` will commit+close the form mid-edit.
- Tool hotkeys V/R/C/T/W are bound in `GraphCanvas` (ignored while typing in
  inputs); edges get labels via right-click → "Label edge…".
- `<ReactFlow colorMode="dark">` handles controls/minimap theming; extra dark
  overrides live in `src/index.css`.
