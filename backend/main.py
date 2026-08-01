"""MetaSpecs backend entrypoint: API + built frontend in one uvicorn process."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.routes import compile, graph, imports, projects, validate

app = FastAPI(title="MetaSpecs", version="0.1.0")

# Vite dev origins; the single-process serve is same-origin.
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=DEV_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_PREFIX = "/api"
app.include_router(projects.router, prefix=API_PREFIX)
app.include_router(graph.router, prefix=API_PREFIX)
app.include_router(validate.router, prefix=API_PREFIX)
app.include_router(compile.router, prefix=API_PREFIX)
app.include_router(imports.router, prefix=API_PREFIX)

DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"

if DIST.exists():
    if (DIST / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        index = DIST / "index.html"
        if not index.is_file():
            raise HTTPException(status_code=404, detail="Not found")
        return FileResponse(index)
