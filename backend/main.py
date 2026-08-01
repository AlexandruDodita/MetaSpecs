"""MetaSpecs backend entrypoint: API + built frontend in one uvicorn process."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.routes import compile, graph, projects, validate

app = FastAPI(title="MetaSpecs", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

API_PREFIX = "/api"
app.include_router(projects.router, prefix=API_PREFIX)
app.include_router(graph.router, prefix=API_PREFIX)
app.include_router(validate.router, prefix=API_PREFIX)
app.include_router(compile.router, prefix=API_PREFIX)

DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"

if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        index = DIST / "index.html"
        return FileResponse(index)
