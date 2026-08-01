"""Snapshot a codebase into a MetaSpecs graph (React Flow JSON).

Deterministic: running twice on an unchanged tree yields byte-identical
output. No timestamps, no random ids, no set-iteration leakage — everything
is sorted and keyed only on repo-relative paths.
"""

from __future__ import annotations

import argparse
import ast
import json
import posixpath
import re
import sys
from pathlib import Path
from typing import Any

LAYER_NAMES = ("backend", "db", "frontend")
SKIP_PARTS = {"node_modules", ".venv", "dist", "__pycache__", ".git", "data"}

SCAN_SPECS = (
    ("backend", "backend/**/*.py", "python"),
    ("backend", "mcp/**/*.py", "python"),
    ("frontend", "frontend/src/**/*.ts", "typescript"),
    ("frontend", "frontend/src/**/*.tsx", "typescript"),
)

LAYER_ROOT = {"backend": "backend", "frontend": "frontend/src"}

COLUMN_W = 400
ROW_STEP = 220
FIRST_ROW = 260  # below the 240-tall container node
MODULE_STYLE = {"width": 260, "height": 180}
CONTAINER_STYLE = {"width": 320, "height": 240}

TS_EXPORT = re.compile(
    r"^export (?:default )?(?:abstract )?(?:async )?"
    r"(function|const|class|interface|type) ([A-Za-z_$][A-Za-z0-9_$]*)",
    re.MULTILINE,
)
TS_IMPORT = re.compile(r"(?:from|import)\s*['\"]([^'\"]+)['\"]")


class Module:
    def __init__(self, layer: str, lang: str, path: str, source: str) -> None:
        self.layer = layer
        self.lang = lang
        self.path = path
        self.source = source
        self.node_id = f"{'py' if lang == 'python' else 'ts'}:{path}"
        self.dirname = path.rsplit("/", 1)[0] if "/" in path else ""

    def __lt__(self, other: "Module") -> bool:
        return self.node_id < other.node_id


# ---------------------------------------------------------------------------
# Python parsing (stdlib ast)
# ---------------------------------------------------------------------------


def _annotation(anno: ast.AST | None) -> str:
    return "" if anno is None else ast.unparse(anno)


def _params(args: ast.arguments) -> str:
    names = [a.arg for a in args.posonlyargs]
    names += [a.arg for a in args.args]
    if args.vararg is not None:
        names.append(args.vararg.arg)
    names += [a.arg for a in args.kwonlyargs]
    if args.kwarg is not None:
        names.append(args.kwarg.arg)
    return ", ".join(names)


def _py_method(name: str, node: ast.AST) -> dict[str, Any]:
    last = name.split(".")[-1]
    return {
        "id": name,
        "kind": "",
        "name": name,
        "visibility": "private" if last.startswith("_") else "public",
        "returnType": _annotation(node.returns),
        "params": _params(node.args),
        "steps": [],
    }


def _unique_ids(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for n in names:
        if n not in seen:
            seen[n] = 1
            out.append(n)
        else:
            seen[n] += 1
            out.append(f"{n}-{seen[n]}")
    return out


def _parse_python(source: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    tree = ast.parse(source)
    fields: list[dict[str, Any]] = []
    named: list[tuple[str, ast.AST]] = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            fields.append({"name": node.name, "visibility": "public", "type": "class"})
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    named.append((f"{node.name}.{item.name}", item))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            named.append((node.name, node))
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name) and target.id.isupper():
                    fields.append(
                        {"name": target.id, "visibility": "public", "type": "const"}
                    )
    ids = _unique_ids([n for n, _ in named])
    methods = [_py_method(nid, node) for nid, (_, node) in zip(ids, named)]
    return fields, methods


def _dotted_to_path(dotted: str) -> str:
    return dotted.replace(".", "/") + ".py"


def _relative_base(current_path: str, level: int) -> str:
    parts = current_path[:-3].split("/")
    return ".".join(parts[:-level])


def _py_candidates(current_path: str, level: int, module: str | None, names: list[Any]) -> list[list[str]]:
    """Candidate target paths per imported name, each ordered name-then-module.

    `from a.b import x` prefers a/b/x.py and falls back to a/b.py; `import a.b`
    yields only a/b.py. Callers stop at the first candidate that resolves.
    """
    if level > 0:
        base = _relative_base(current_path, level)
        if module:
            base = f"{base}.{module}"
    else:
        base = module
    if not base:
        return []
    base_path = _dotted_to_path(base)
    if not names:
        return [[base_path]]
    per_name: list[list[str]] = []
    for alias in names:
        if alias.name == "*":
            per_name.append([base_path])
        else:
            per_name.append([_dotted_to_path(f"{base}.{alias.name}"), base_path])
    return per_name


def _python_deps(current_path: str, tree: ast.AST) -> list[list[str]]:
    deps: list[list[str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                deps.extend(_py_candidates(current_path, 0, alias.name, None))
        elif isinstance(node, ast.ImportFrom):
            deps.extend(_py_candidates(current_path, node.level, node.module, node.names))
    return deps


# ---------------------------------------------------------------------------
# TypeScript / TSX parsing (regex)
# ---------------------------------------------------------------------------


def _split_top_level(s: str) -> list[str]:
    parts: list[str] = []
    cur: list[str] = []
    depth = 0
    in_str: str | None = None
    i = 0
    while i < len(s):
        c = s[i]
        if in_str is not None:
            cur.append(c)
            if c == "\\":
                cur.append(s[i + 1] if i + 1 < len(s) else "")
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in ("'", '"', "`"):
            in_str = c
            cur.append(c)
        elif c in "([{<":
            depth += 1
            cur.append(c)
        elif c in ")]}>":
            depth -= 1
            cur.append(c)
        elif c == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(c)
        i += 1
    if cur or parts:
        parts.append("".join(cur).strip())
    return parts


def _extract_group(text: str, i: int) -> str:
    """Balanced parenthesised group starting at text[i]=='('."""
    depth = 0
    j = i
    in_str: str | None = None
    while j < len(text):
        c = text[j]
        if in_str is not None:
            if c == "\\":
                j += 2
                continue
            if c == in_str:
                in_str = None
        elif c in ("'", '"', "`"):
            in_str = c
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return text[i + 1 : j]
        j += 1
    return ""


def _ts_params(group: str) -> str:
    if not group:
        return ""
    names = []
    for part in _split_top_level(group):
        m = re.search(r"[A-Za-z_$][A-Za-z0-9_$]*", part)
        if m:
            names.append(m.group(0))
    return ", ".join(names)


def _arrow_params(text: str, line_start: int, line_end: int) -> str:
    """Params for `export const NAME = (...) =>`; '' if not a clean arrow."""
    line = text[line_start:line_end]
    eq = line.find("=")
    if eq == -1:
        return ""
    i = line_start + eq + 1
    while i < len(text) and text[i] in " \t":
        i += 1
    if i >= len(text) or text[i] != "(":
        return ""
    return _ts_params(_extract_group(text, i))


def _func_params(text: str, name_end: int) -> str:
    """Params for `export function NAME...`, skipping generics first."""
    i = name_end
    while i < len(text) and text[i] in " \t":
        i += 1
    if i < len(text) and text[i] == "<":
        depth = 0
        while i < len(text):
            if text[i] == "<":
                depth += 1
            elif text[i] == ">":
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            i += 1
    while i < len(text) and text[i] in " \t":
        i += 1
    if i >= len(text) or text[i] != "(":
        return ""
    return _ts_params(_extract_group(text, i))


def _parse_ts(text: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fields: list[dict[str, Any]] = []
    methods: list[dict[str, Any]] = []
    for m in TS_EXPORT.finditer(text):
        kind, name = m.group(1), m.group(2)
        line_start = text.rfind("\n", 0, m.start()) + 1
        line_end = text.find("\n", m.end())
        if line_end == -1:
            line_end = len(text)
        line = text[line_start:line_end]
        if kind == "function":
            methods.append(
                {
                    "id": name,
                    "kind": "",
                    "name": name,
                    "visibility": "public",
                    "returnType": "",
                    "params": _func_params(text, m.end()),
                    "steps": [],
                }
            )
        elif kind == "const":
            arrow = False
            eq = line.find("=")
            if eq != -1 and ("=>" in line or "(" in line[eq:]):
                arrow = True
            if arrow:
                methods.append(
                    {
                        "id": name,
                        "kind": "",
                        "name": name,
                        "visibility": "public",
                        "returnType": "",
                        "params": _arrow_params(text, line_start, line_end),
                        "steps": [],
                    }
                )
            else:
                fields.append({"name": name, "visibility": "public", "type": "const"})
        else:
            fields.append({"name": name, "visibility": "public", "type": kind})
    return fields, methods


def _ts_deps(current_path: str, text: str) -> list[list[str]]:
    base_dir = current_path.rsplit("/", 1)[0] if "/" in current_path else ""
    deps: list[list[str]] = []
    for m in TS_IMPORT.finditer(text):
        spec = m.group(1)
        if not spec.startswith("."):
            continue
        combined = posixpath.normpath(posixpath.join(base_dir, spec))
        cands = [combined]
        if not combined.endswith((".ts", ".tsx")):
            cands += [combined + e for e in (".ts", ".tsx")]
            cands += [combined + i for i in ("/index.ts", "/index.tsx")]
        deps.append(cands)
    return deps


# ---------------------------------------------------------------------------
# Graph assembly
# ---------------------------------------------------------------------------


def parse_module(m: Module) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if m.lang == "python":
        return _parse_python(m.source)
    return _parse_ts(m.source)


def module_node(m: Module, pos: tuple[int, int], fields: list[dict], methods: list[dict]) -> dict:
    return {
        "id": m.node_id,
        "type": "class",
        "position": {"x": pos[0], "y": pos[1]},
        "data": {
            "label": m.path.rsplit("/", 1)[-1][: -len(Path(m.path).suffix)],
            "path": m.path,
            "description": "",
            "fields": fields,
            "methods": methods,
        },
        "style": MODULE_STYLE,
    }


def build_layer(
    layer: str,
    mods: list[Module],
    modules_by_path: dict[str, Module],
    edge_ids: set[str],
    skipped: list[dict[str, str]],
) -> dict[str, Any]:
    by_dir: dict[str, list[Module]] = {}
    for m in mods:
        by_dir.setdefault(m.dirname, []).append(m)
    dirs = sorted(by_dir)
    layer_root = LAYER_ROOT.get(layer)
    container_dirs = [] if (len(dirs) == 1 and dirs[0] == layer_root) else dirs

    positions: dict[str, tuple[int, int]] = {}
    col = 0
    for d in container_dirs:
        positions[f"pkg:{d}"] = (col * COLUMN_W, 0)
        for j, m in enumerate(sorted(by_dir[d])):
            positions[m.node_id] = (col * COLUMN_W, FIRST_ROW + j * ROW_STEP)
        col += 1
    loose = [m for d, ms in by_dir.items() if d not in container_dirs for m in ms]
    for j, m in enumerate(sorted(loose)):
        positions[m.node_id] = (col * COLUMN_W, j * ROW_STEP)

    nodes: list[dict[str, Any]] = []
    for d in container_dirs:
        cid = f"pkg:{d}"
        nodes.append(
            {
                "id": cid,
                "type": "service",
                "position": {"x": positions[cid][0], "y": positions[cid][1]},
                "data": {"label": d.rsplit("/", 1)[-1], "path": d, "description": ""},
                "style": CONTAINER_STYLE,
            }
        )
        for m in sorted(by_dir[d]):
            fields, methods = parse_module(m)
            nodes.append(module_node(m, positions[m.node_id], fields, methods))
    for m in sorted(loose):
        fields, methods = parse_module(m)
        nodes.append(module_node(m, positions[m.node_id], fields, methods))
    nodes.sort(key=lambda n: n["id"])

    edges: list[dict[str, Any]] = []
    for d in container_dirs:
        cid = f"pkg:{d}"
        for m in sorted(by_dir[d]):
            edges.append(_make_edge(cid, m.node_id, "contains", "", edge_ids))
    for m in sorted(mods):
        deps = _module_deps(m, modules_by_path, layer, skipped)
        for target in sorted(deps):
            edges.append(_make_edge(m.node_id, target, "depends-on", "in-process", edge_ids))
    edges.sort(key=lambda e: e["id"])
    return {"nodes": nodes, "edges": edges}


def _module_deps(
    m: Module,
    modules_by_path: dict[str, Module],
    layer: str,
    skipped: list[dict[str, str]],
) -> set[str]:
    deps = (
        _python_deps(m.path, ast.parse(m.source))
        if m.lang == "python"
        else _ts_deps(m.path, m.source)
    )
    resolved: set[str] = set()
    for candidates in deps:
        for cand in candidates:
            tmod = modules_by_path.get(cand)
            if tmod is None:
                continue
            if tmod.layer == layer:
                resolved.add(tmod.node_id)
            else:
                skipped.append(
                    {
                        "source": m.node_id,
                        "target": tmod.layer,
                        "reason": (
                            f"module {m.path} imports {tmod.path}; single-layer graphs "
                            "cannot represent cross-layer edges"
                        ),
                    }
                )
            break
    return resolved


def _make_edge(
    source: str, target: str, kind: str, protocol: str, used: set[str]
) -> dict[str, str]:
    base = f"e:{source}-->{target}"
    eid = base
    n = 2
    while eid in used:
        eid = f"{base}-{n}"
        n += 1
    used.add(eid)
    return {"id": eid, "source": source, "target": target, "label": "", "kind": kind, "protocol": protocol}


def scan(root: Path) -> tuple[list[Module], dict[str, Module]]:
    modules: list[Module] = []
    by_path: dict[str, Module] = {}
    for layer, pattern, lang in SCAN_SPECS:
        for p in root.glob(pattern):
            if not p.is_file():
                continue
            rel = p.relative_to(root).as_posix()
            if any(part in SKIP_PARTS for part in Path(rel).parts):
                continue
            if rel.startswith("frontend/_"):
                continue
            m = Module(layer, lang, rel, p.read_text(encoding="utf-8"))
            modules.append(m)
            by_path[rel] = m
    modules.sort()
    return modules, by_path


def build(root: Path) -> dict[str, Any]:
    modules, by_path = scan(root)
    edge_ids: set[str] = set()
    skipped: list[dict[str, str]] = []
    graphs: dict[str, Any] = {}
    for layer in LAYER_NAMES:
        if layer == "db":
            graphs[layer] = {"nodes": [], "edges": []}
            continue
        mods = [m for m in modules if m.layer == layer]
        graphs[layer] = build_layer(layer, mods, by_path, edge_ids, skipped)
    skipped.sort(key=lambda s: (s["source"], s["target"], s["reason"]))
    return {
        "metaspecs_import": 1,
        "root": root.name,
        "graphs": graphs,
        "skipped_cross_layer": skipped,
    }


def push(project_id: str, api: str, graphs: dict[str, Any]) -> None:
    import httpx  # optional dep, only needed for --push

    with httpx.Client(base_url=api, timeout=60.0) as client:
        for layer in LAYER_NAMES:
            resp = client.post(
                f"/api/projects/{project_id}/graph/{layer}", json=graphs[layer]
            )
            resp.raise_for_status()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=None, help="repo to scan (default: repo root)")
    parser.add_argument("--out", default=None, help="write JSON here (default: stdout)")
    parser.add_argument("--push", default=None, help="project id to POST the graphs to")
    parser.add_argument("--api", default="http://localhost:8000", help="API base URL")
    args = parser.parse_args(argv)

    root = (
        Path(args.root).resolve()
        if args.root
        else Path(__file__).resolve().parents[1]
    )
    data = build(root)
    text = json.dumps(data, indent=2) + "\n"

    if args.push:
        push(args.push, args.api.rstrip("/"), data["graphs"])
    if args.out:
        Path(args.out).write_text(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
