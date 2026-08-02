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
  `backend/routes/{projects,graph,validate,compile,imports,fs}.py`, each with
  its own `APIRouter`, mounted with prefix `/api`. Pydantic models in
  `backend/models.py` (incl. `Project`, `ProjectInfo`, `ProjectReports`,
  `ImportRequest`/`ImportStats`/`ImportResult`, `DirEntry`/`DirListing`).
  `routes/fs.py` serves `GET /fs/dirs` — directory NAMES only, one level, never
  file contents; it exists because browsers refuse JS an absolute path, so a
  native folder dialog cannot tell the server what to scan. Safe only because
  uvicorn binds `127.0.0.1` and CORS is limited to the Vite origins; do not
  widen either without revisiting it. Services in
  `backend/services/`: `storage.py` (JSON file IO, one file per project),
  `llm.py` (OpenAI + instructor client), `validate.py`, `compile.py`,
  `importer.py` (thin wrapper over `tools/import_repo.py` — it holds no scanning
  logic of its own; `from tools import import_repo` works because the repo root
  is on `sys.path` and `tools/` is an implicit namespace package).
- `frontend/` — Vite app (run everything with `npm --prefix frontend ...`).
  `src/types.ts` shared types; `src/store.ts` all Zustand graph state (active
  `project`, graphs, active layer, tools
  `select|rect|circle|table|class|service|file|wire`, live drag-to-draw rect,
  edit mode, selection); `src/nodeFactory.ts` node builders
  (default sizes, per-kind data); `src/api.ts` fetch helpers (all endpoints are
  project-scoped); `src/components/GraphCanvas.tsx` one `<ReactFlow>` per layer
  (drag-to-draw preview, context menus, wire tool, dark mode);
  `src/components/ProjectPicker.tsx` create/open/delete project screen (shown
  when `store.project` is null) — also hosts "Import codebase…", which opens
  `src/components/DirectoryPicker.tsx` (modal folder browser over `/fs/dirs`:
  breadcrumb, Home/Up, show-hidden, `git` badges, paste-a-path box, Escape to
  close), then creates a project, POSTs the chosen path to `/import`, and shows
  a counts/languages/warnings summary; a failed import deletes the project it
  just created; `src/components/TableNode.tsx` table node
  (Oracle-style schema rows, one left/right handle pair per column) and
  `src/components/ShapeNode.tsx` generic shapes — rect (header + item list) and
  circle — both with edit mode (dropdowns/textarea, save/cancel/outside-click);
  `src/components/PreviewNode.tsx` dashed drag preview;
  `src/components/ClassNode.tsx` class object (fields + methods rows with
  visibility badges, TS-highlighted signatures; click a method to expand a
  tree of logic steps `step|branch|call` with inline label edit, reorder and
  delete; edit form for label/fields/methods; class and method docstrings show
  as `notes` blocks), `src/components/ServiceNode.tsx` service/controller
  container — membership comes from WIRES (any edge to a file or class);
  collapsed body lists the wired files/classes, expanded body is a collapsible
  tree (files → classes → methods → steps),
  `src/components/FileNode.tsx` file/module container — module-level functions
  live in its own `methods`, classes wire in; expanded shows its functions and
  wired classes in a tree, collapsed lists the wired classes,
  `src/components/Tree.tsx` shared tree rows (`TreeFileRow`/`TreeClassRow`/
  `TreeMethodRow`, each expands to docstring notes then children),
  `src/components/Highlighted.tsx` TS-like token highlighting +
  `VisibilityBadge` (from `src/highlight.ts` tokenizer; tree/step styles in
  `src/logic.css`); node types are `table|shape|class|service|file|preview`,
  tools `select|rect|circle|table|class|service|file|wire` (class/file:
  backend+frontend layers, service: backend only);
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
  node/wire editing, reports, validate and compile. Its `NODE_TYPES` must track
  the persistable types in `src/types.ts` (`preview` stays rejected), and its
  `EDGE_KINDS` must mirror `EDGE_KIND_NAMES` in `backend/models.py` (the repo
  root is not importable from `mcp/`). `set_edge_kind` leaves `protocol` alone
  when the argument is omitted — passing `""` is how you clear it.
- `tools/` — snapshot/drift logic, stdlib only. `import_repo.py` is the single
  repo scanner: it is both a CLI (`--root`, `--out`, `--push <project-id>`,
  `--max-files`) and the library the backend's import endpoint calls. Never copy
  scanning logic into `backend/`. It emits one `file:` node per module
  (module-level functions as `methods`, module docstring as `notes`), one
  `class:` node per Python/TS class (`<prefix>:<path>#<ClassName>` ids, like SQL
  tables), wires `pkg → file → class` with `contains`, and derives `calls`
  edges between nodes from statically resolvable call sites (Python AST,
  TS/JSDoc regex). `diff_graphs.py` compares two graphs and exits 1 on drift.
  See "Snapshot and drift" below.
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
  `frontend/`) is used for browser smoke tests — run harnesses from inside
  `frontend/` so `playwright` resolves.
- Import a tree: `.venv/bin/python tools/import_repo.py --root <dir> --out x.json`,
  or the "Import codebase" field on the project picker.
- The dev backend is usually started WITHOUT `--reload`; a model or route change
  needs a real restart. Check before believing a green API test:
  `curl -s localhost:8000/openapi.json | grep <new-route>`.

## Contracts

Stored graph JSON is serializable React Flow v12 state:

```json
{"nodes": [{"id": "n-1", "type": "table", "position": {"x": 0, "y": 0},
  "data": {"label": "users", "path": "backend/models.py", "description": "",
           "columns": [{"name": "id", "type": "uuid", "constraint": "PRIMARY KEY"}]}}],
 "edges": [{"id": "e-1", "source": "n-1", "target": "n-2", "label": "",
            "kind": "depends-on", "protocol": ""}]}
```

- `data.path` (repo-relative) and `data.description` (markdown) are optional on
  every node kind. They ride `GraphNode.data`'s passthrough — there is no
  Pydantic field for them. `path` is the join key for drift detection, so treat
  it as load-bearing, not decoration.
- Edge `kind` is one of `contains|calls|implements|reads|writes|depends-on`,
  declared on `GraphEdge` and defaulting to `depends-on`; `protocol` is free
  text. Edges stored before this existed read back as `depends-on` — there is no
  migration. **Container membership does NOT consult `kind`**: any class wired
  to a file, or any file/class wired to a service, belongs to it, in either
  direction. The importer's `calls` edges carry the called names in `label`.
- Edge stroke colour is derived from `kind` in `GraphCanvas.tsx` (`EDGE_STROKE`).

## Snapshot and drift

A graph is a point-in-time **copy** of a codebase, never a live view. The loop:
import → hand-edit the graph → hand it to a coding agent → re-import → diff.

- `tools/import_repo.py` must stay **byte-deterministic**: same tree in, same
  JSON out. No timestamps, no uuids, sorted everything. Node ids are derived
  from the path (`py:backend/services/storage.py`, `pkg:backend/services`,
  `py:backend/models.py#Project` for classes) precisely so a re-import matches
  the previous one. The gate before any change lands: scan twice into two files
  and `cmp` them.
- The scanner is **repo-agnostic** — it discovers files with `os.walk`, prunes
  `SKIP_DIRS`, honours `.gitignore` (own matcher; `fnmatch` is wrong here
  because its `*` crosses `/`), and infers a layer per file with `infer_layer`
  (path segments beat extension: `DB_DIRS` → `FRONTEND_DIRS` → `BACKEND_DIRS`,
  then `FRONTEND_LANGS`/`BACKEND_LANGS`). Nothing may hardcode this repo's
  directory names.
- Languages live in exactly two registries, `PARSERS` and `DEPS`, both keyed by
  the language name from `LANGUAGES`. Adding a language means adding entries
  there — never a second `if lang == ...` chain. Every parser has the signature
  `(path, source) -> (fields, methods, notes, aux)`: methods carry `owner`
  (class name or `''` for module-level, stripped before persisting) and `notes`
  (docstring), `notes` is `{module, classes}` docstrings, `aux` is
  language-specific (Python AST + import aliases, TS exports/imports) and feeds
  the call-graph pass. Every deps function
  `(path, source) -> list[list[str]]` (candidate groups, first hit wins).
- Docstrings become `notes`: Python triple-quote via `ast.get_docstring`
  (module → file node, class → class node, function → method), TS/JS only
  `/** ... */` JSDoc blocks directly above a declaration (first block before
  the first declaration is the module note). Non-Python/TS languages return
  empty notes and put every method on the file node.
- The call-graph pass (kind `calls`, same layer only) resolves each call site
  to a class node (callee method/class) or file node (module-level function)
  via the per-layer registry `{rel path: {classes, funcs}}` and import aliases.
  Python uses the AST (`import a.b as x`, `from a.b import c as d`, dotted
  chains, `self`/`cls` skipped); TS uses regex over comment/string-stripped
  source where the callee base must be an import (bare imported names and
  `alias.sym(`). Calls inside the same module never produce edges — the file's
  tree already shows them. Resolution is conservative: anything ambiguous
  yields nothing. Edge labels list the called names (sorted, capped at 40
  chars); one edge per (caller, callee) pair.
- Parameter lists: `_ts_params(group, last=True)` for type-first languages
  (Java, C#), default for `name: Type` and `name Type` (TS, Kotlin, Go).
- SQL is the exception to module-per-file: `CREATE TABLE` emits `table` nodes
  (`tbl:<path>#<name>`) with parsed columns in the `db` layer, and `REFERENCES`
  becomes one `depends-on`/`foreign-key` edge per relation — a FK written both
  inline and as a table-level constraint must not produce two edges.
- Over `max_files` raises `ScanLimitError` (CLI exit 2, HTTP 413). Never
  truncate silently.
- `POST /api/projects/{id}/import` `{path, max_files?}` writes all three layers
  plus `repo_path` in **one** `storage.write_project` call, and names a
  first-time import after the scanned root (a re-import keeps the name).
- Edges cannot cross layers (`Project.graphs` is `dict[layer, LayerGraph]`, and
  edges live inside one layer). The importer therefore drops cross-layer imports
  into a top-level `skipped_cross_layer` list rather than emitting them.
- Static import analysis cannot see the frontend→backend relationship at all: it
  is an HTTP call, not an import. That edge has to be authored by hand.
- `snapshots/metaspecs.json` is this repo described by its own importer — the
  committed baseline to diff a fresh scan against:
  `.venv/bin/python tools/import_repo.py --out /tmp/now.json && .venv/bin/python tools/diff_graphs.py snapshots/metaspecs.json /tmp/now.json`
  (exit 1 means the code moved). Regenerate it in the same commit as any change
  that shifts the graph, or it silently stops being a baseline. Committing it is
  safe: `.json` is not in `LANGUAGES`, so the file cannot feed back into a
  later scan.
- `tools/diff_graphs.py` matches nodes by id first, then by non-empty
  `data.path` — a node added by hand in the UI has a random id and would never
  id-match its imported counterpart. Those show under "reconciled by path"
  (class nodes share their module's `path`, so only the first claims it).
  `position`/`style`/`measured` are ignored unless `--include-layout`; node and
  method `notes` docstrings are compared like any other field.

- Project files live at `data/projects/<id>.json`; the `app: "metaspecs"`
  marker (plus `version`) is what identifies a file as one of our projects —
  `list_projects()` ignores anything else in that directory.
- Project file shape: `{app, version, id, name, created_at, updated_at, scope,
  graphs: {backend, db, frontend}, validation, tasks}`. `scope` + the last
  validation report and task list are saved with the project and restored on
  open (`GET /api/projects/{id}/reports`).
- All API routes are project-scoped; the old unscoped routes
  (`/api/graph/{layer}` etc.) are gone. The SPA catch-all in `main.py` serves
  `index.html` only for non-API GETs; unmatched `/api/` paths 404.
- CORS is pinned to `DEV_ORIGINS` in `main.py`, not `*` — the API is
  unauthenticated and can delete projects.
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
  / `backend.services.compile`). A missing role or unresolved `${ENV_VAR}` key
  raises `LLMConfigError` → 500 with the reason in `detail`; the role cache
  reloads on `models.yaml` mtime change.

## Gotchas

- The app boots into `ProjectPicker` when `store.project` is null; on startup
  App resumes the id in `metaspecs.activeProjectId` (cleared on 404). All
  graph/validate/compile calls are project-scoped — `store.persist` and
  `store.loadAll` silently no-op without an active project, so the canvas is
  never rendered until one is open.
- Project file schema lives in `models.Project`; graphs are the
  `graphs` sub-object. Writing a graph bumps `updated_at`; validate/compile
  also persist `scope` into the project file (restored via `/reports`).
- Every write helper in `storage.py` rewrites the WHOLE project file, so each
  must hold `_project_lock(project_id)` across read AND write or concurrent
  per-layer saves clobber each other. Writes go through `_atomic_write`
  (temp file + `os.replace`).
- `GraphNode.data` is Pydantic `dict[str, Any]`; the table shape lives in
  `src/types.ts` (`TableNodeData`) and the generic shape in `ShapeNodeData`
  (`kind: rect|circle`, `label`, `items[]`). Keep both in sync when changing.
- `constraint` is free-text (e.g. "PRIMARY KEY", "NOT NULL"), never an enum;
  the edit-mode dropdowns in `TableNode.tsx` are suggestions only.
- An imported layer looks empty on first open: files land inside `pkg:`
  service containers, and `GraphCanvas` hides a node while every container it
  is wired to is collapsed. Expand a service to bring its files onto the
  canvas; files start expanded, so their classes and `calls` edges follow.
- `api.ts`'s `request()` prefers FastAPI's JSON `detail` over
  `status statusText`, so route handlers should raise `HTTPException` with a
  message worth showing a user — it reaches the screen verbatim.
- `DirectoryPicker` renders as the last child of `.project-picker__inner`,
  outside both `<form>`s — its jump-to-path box is its own form, and a nested
  form is invalid HTML that would submit the outer one. Its `go()` mirrors the
  landed path back into that box, so a listing that resolves mid-typing
  overwrites what you were typing (only reachable in the first moments after
  the modal opens).
- Don't reuse `.project-picker__name` for a second input on the picker: an
  earlier version did, which made that selector ambiguous and broke
  `e2e-smoke.mjs` under Playwright strict mode.
- Placement tools (`rect|circle|table`) draw on drag: pane `mousedown`
  (native listener on `.react-flow__pane`, v12 has no `onPaneMouseDown` prop)
  → live `drawing` rect in the store → a `preview` node appended to the
  `nodes` prop (never persisted) → `mouseup` creates a sized node via
  `makeNode(kind, x, y, w, h)`; `style: {width, height}` holds the size.
- Node sizes persist via `NodeResizer onResizeEnd` → `updateNodeSize`
  (writes `node.style.width/height`); RF's own resize only sets
  `measured`/`width` which Pydantic would otherwise drop — the backend
  `extra="allow"` passthrough (on the shared `FlowElement` base) is what makes
  both survive a round-trip. It is opt-OUT for UI state: the keys in
  `TRANSIENT_FLOW_FIELDS` are stripped during validation — persisting
  `selected` made reopened projects render pre-selected nodes. Add new RF UI
  flags to that tuple.
- `DEFAULT_SIZE` (`src/nodeFactory.ts`) is mirrored in `mcp/server.py`; keep
  them in sync. `placeableKindOf(node)` is the ONE node→`PlaceableKind` map,
  used by `geometry.nodeSizeOf` and `store.duplicateNode`.
- Resize handles are always rendered (`isVisible` default) and revealed via
  CSS (`.react-flow__resize-control { opacity: 0 }` + `:hover`/`.selected`
  on `.react-flow__node`); sizes are in flow units — at zoom≠1 a screen-space
  drag maps through the current viewport.
- Auto-fit runs once per `layer:loadSeq` (a ref guard in `GraphCanvas`), i.e.
  only for a freshly loaded graph and never after a user edit, so drag-to-draw
  coordinates stay deterministic. `loadAll` bumps `loadSeq`.
- All graph mutation flows through Zustand actions in `src/store.ts` using
  `applyNodeChanges`/`applyEdgeChanges`; cast changes/nodes/edges to React Flow
  `NodeChange[]`/`Node[]` at that boundary (`as unknown as ...` where TS
  disagrees).
- `nodeTypes = { table: TableNode, shape: ShapeNode, class: ClassNode,
  service: ServiceNode, file: FileNode, preview: PreviewNode }`;
  the custom node reads `activeLayer` from the store so its actions target
  the right layer.
- Object hierarchy is a TREE, not nested canvases: classes belong to files and
  files belong to services via wires (edges, either direction); a service's
  object area (collapsed) lists wired files/classes and its expanded body is a
  collapsible tree (files → classes → methods → steps). Method logic lives as
  `Method.steps` (ordered `LogicStep[]`), written through `updateMethodSteps`
  (store; works on class AND file nodes). Expansion is UI-only store state
  (`expanded`/`expandedMethod`), never persisted. `ServiceNode`/`FileNode`
  derive membership by subscribing to the layer's edges.
- Tree hiding: `GraphCanvas` filters the rendered graph — a node is hidden
  from the canvas while every container (service or file) it is wired to is
  collapsed or itself hidden (a file whose services are all collapsed is
  hidden, which hides its classes in turn); edges touching hidden nodes are
  filtered too. The store keeps the nodes; the wire tool's snap targets the
  filtered set.
- The `expanded` map is shared by services, classes and files but their
  DEFAULTS differ (`EXPANDED_BY_DEFAULT` in `store.ts`: classes and files
  expanded, services collapsed). Read it only via
  `isExpanded(expanded, nodeId, kind)` and toggle only via
  `toggleExpanded(nodeId, kind)` — an inline `expanded[id]` reads the
  wrong default and makes the first toggle a no-op.
- `ClassNode`/`ServiceNode`/`FileNode` read their data from React Flow's
  `data` prop plus the store for membership/expansion; top-level edit forms
  use the store draft machinery (`editingNodeId`/`editDraft`).
- Table edit state lives in the store (`editingNodeId`/`editDraft`), NOT in
  node data — the stored graph JSON must stay serializable.
- Clicks inside the edit form must `stopPropagation()` or React Flow's
  `onNodeClick` will commit+close the form mid-edit.
- Tool hotkeys V/R/C/T/K/S/F/W are bound in `GraphCanvas` (ignored while typing
  in inputs); edges get labels via right-click → "Label edge…".
- `<ReactFlow colorMode="dark">` handles controls/minimap theming; extra dark
  overrides live in `src/index.css`.
