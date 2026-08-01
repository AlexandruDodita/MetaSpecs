"""Filesystem directory listing: lets the UI browse for an import root."""
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.models import DirEntry, DirListing

router = APIRouter()

MAX_ENTRIES = 1000


@router.get("/fs/dirs", response_model=DirListing)
def list_dirs(path: str = "", show_hidden: bool = False) -> DirListing:
    if not path.strip():
        resolved = Path.home()
    else:
        resolved = Path(path).expanduser()
    resolved = resolved.resolve()

    if not resolved.exists():
        raise HTTPException(status_code=400, detail=f"no such directory: {resolved}")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail=f"not a directory: {resolved}")

    try:
        # Symlinked directories are kept — a `~/code -> /mnt/data/code` shortcut
        # is exactly what someone browsing for a checkout wants to follow, and
        # there is no loop risk when only one level is listed.
        with os.scandir(resolved) as it:
            entries = [entry for entry in it if entry.is_dir()]
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=f"permission denied: {resolved}") from exc
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"cannot read: {resolved}") from exc

    if not show_hidden:
        entries = [entry for entry in entries if not entry.name.startswith(".")]

    entries.sort(key=lambda entry: (entry.name.lower(), entry.name))

    truncated = False
    if len(entries) > MAX_ENTRIES:
        entries = entries[:MAX_ENTRIES]
        truncated = True

    dir_entries = [
        DirEntry(name=entry.name, path=entry.path, is_repo=_has_git_dir(entry.path))
        for entry in entries
    ]

    parent = None if resolved.parent == resolved else str(resolved.parent)
    return DirListing(
        path=str(resolved),
        parent=parent,
        home=str(Path.home()),
        entries=dir_entries,
        truncated=truncated,
    )


def _has_git_dir(path: str) -> bool:
    try:
        return (Path(path) / ".git").exists()
    except (PermissionError, OSError):
        return False
