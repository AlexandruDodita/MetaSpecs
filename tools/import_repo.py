"""Snapshot a codebase into a MetaSpecs graph (React Flow JSON).

Universal repo scanner: discovers its own files with os.walk (honouring
.gitignore), infers a layer (backend/db/frontend) per file, and understands a
range of languages. Deterministic: running twice on an unchanged tree yields
byte-identical output. No timestamps, no random ids, no set-iteration leakage —
everything is sorted and keyed only on repo-relative paths.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import posixpath
import re
import sys
from pathlib import Path
from typing import Any

LAYER_NAMES = ("backend", "db", "frontend")

MAX_FILE_BYTES = 1_000_000
DEFAULT_MAX_FILES = 4000

SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    "dist", "build", "out", "target", "vendor", "coverage", ".cache",
    ".next", ".nuxt", ".svelte-kit", ".idea", ".vscode", ".gradle",
    "bin", "obj", "Pods", "DerivedData", "data",
}


class ScanLimitError(Exception):
    """Raised when a tree has more source files than the caller allowed."""


LANGUAGES = {
    ".py": "python",   ".pyi": "python",
    ".ts": "typescript", ".tsx": "typescript",
    ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript",
    ".vue": "vue", ".svelte": "svelte",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin", ".kts": "kotlin",
    ".cs": "csharp",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".sql": "sql",
}

ID_PREFIX = {
    "python": "py", "typescript": "ts", "javascript": "js",
    "vue": "vue", "svelte": "svelte", "go": "go", "java": "java",
    "kotlin": "kt", "csharp": "cs", "rust": "rs", "ruby": "rb",
    "php": "php", "sql": "sql",
}

DB_DIRS = {"migrations", "migration", "db", "database", "schema", "schemas", "sql"}
FRONTEND_DIRS = {"frontend", "client", "web", "ui", "www", "webapp",
                 "components", "pages", "views", "public", "static", "assets"}
BACKEND_DIRS = {"backend", "server", "api", "services", "service",
                "worker", "workers", "cmd", "internal", "domain"}
FRONTEND_LANGS = {"typescript", "javascript", "vue", "svelte"}
BACKEND_LANGS = {"python", "go", "java", "kotlin", "csharp", "rust", "ruby", "php"}

COLUMN_W = 400
ROW_STEP = 220
FIRST_ROW = 260  # below the 240-tall container node
MODULE_STYLE = {"width": 260, "height": 180}
CONTAINER_STYLE = {"width": 320, "height": 240}

TS_EXPORT = re.compile(
    r"^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?"
    r"(function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)",
    re.MULTILINE,
)
TS_IMPORT = re.compile(r"(?:from|import)\s*['\"]([^'\"]+)['\"]")
TS_CLASS_METHOD = re.compile(
    r"^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?"
    r"([A-Za-z_$][\w$]*)\s*\(",
    re.MULTILINE,
)
TS_SKIP_KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "function"}
TS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte")
TS_INDEX_FILES = ("/index.ts", "/index.tsx", "/index.js", "/index.jsx")
SCRIPT_BLOCK = re.compile(r"<script\b[^>]*>(.*?)</script>", re.DOTALL)

GO_RECEIVER = re.compile(
    r"^func\s+\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*\(",
    re.MULTILINE,
)
GO_FUNC = re.compile(r"^func\s+([A-Za-z_]\w*)\s*\(", re.MULTILINE)
GO_TYPE = re.compile(r"^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b", re.MULTILINE)
GO_TYPE_ALIAS = re.compile(r"^type\s+([A-Za-z_]\w*)\s+\S", re.MULTILINE)
GO_CONST = re.compile(r"^(const|var)\s+([A-Za-z_]\w*)", re.MULTILINE)

JAVA_TYPE = re.compile(
    r"^\s*(?:@\w+\s*)*(public|private|protected)?\s*"
    r"(?:abstract\s+|final\s+|static\s+|sealed\s+|data\s+|open\s+|inner\s+)*"
    r"(class|interface|enum|record|object)\s+([A-Za-z_]\w*)",
    re.MULTILINE,
)
JAVA_METHOD = re.compile(
    r"^\s*(?:@\w+\s*)*(public|private|protected)?\s*"
    r"(?:static\s+|final\s+|abstract\s+|synchronized\s+|native\s+)*"
    r"(?:<[^>]+>\s*)?([A-Za-z_][\w<>\[\],.?\s]*?)\s+([A-Za-z_]\w*)\s*\(",
    re.MULTILINE,
)
KOTLIN_FUN = re.compile(
    r"^\s*(?:@\w+\s*)*(public|private|protected|internal)?\s*"
    r"(?:suspend\s+|inline\s+|override\s+|open\s+|abstract\s+)*"
    r"fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(",
    re.MULTILINE,
)
CSHARP_TYPE = re.compile(
    r"^\s*(?:@\w+\s*)*(public|private|protected)?\s*"
    r"(?:abstract\s+|final\s+|static\s+|sealed\s+|data\s+|open\s+|inner\s+)*"
    r"(class|interface|enum|record|struct)\s+([A-Za-z_]\w*)",
    re.MULTILINE,
)
CSHARP_METHOD = re.compile(
    r"^\s*(?:@\w+\s*)*(public|private|protected)?\s*"
    r"(?:static\s+|final\s+|abstract\s+|synchronized\s+|native\s+"
    r"|virtual\s+|override\s+|async\s+|readonly\s+|partial\s+)*"
    r"(?:<[^>]+>\s*)?([A-Za-z_][\w<>\[\],.?\s]*?)\s+([A-Za-z_]\w*)\s*\(",
    re.MULTILINE,
)
JVM_SKIP_METHODS = {"if", "for", "while", "switch", "catch", "synchronized", "return", "new"}
VISIBILITY_WORDS = {"public", "private", "protected", "internal"}

RUST_FN = re.compile(r"^\s*(pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_]\w*)", re.MULTILINE)
RUST_TYPE = re.compile(
    r"^\s*(pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|union)\s+([A-Za-z_]\w*)",
    re.MULTILINE,
)
RUST_CONST = re.compile(
    r"^\s*(pub(?:\([^)]*\))?\s+)?(const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)",
    re.MULTILINE,
)

RUBY_TYPE = re.compile(r"^\s*(class|module)\s+([A-Z]\w*)", re.MULTILINE)
RUBY_DEF = re.compile(r"^\s*def\s+(?:self\.)?([a-z_]\w*[?!=]?)", re.MULTILINE)
RUBY_CONST = re.compile(r"^\s*([A-Z][A-Z0-9_]*)\s*=", re.MULTILINE)

PHP_TYPE = re.compile(
    r"^\s*(?:abstract\s+|final\s+)*(class|interface|trait|enum)\s+(\w+)",
    re.MULTILINE,
)
PHP_FUN = re.compile(
    r"^\s*(public|private|protected)?\s*(?:static\s+)?function\s+&?(\w+)\s*\(",
    re.MULTILINE,
)
PHP_PROP = re.compile(r"^\s*(public|private|protected)\s+(?:static\s+)?\$(\w+)", re.MULTILINE)

SQL_CREATE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(",
    re.IGNORECASE | re.MULTILINE,
)
SQL_TABLE_CONSTRAINTS = {
    "PRIMARY", "UNIQUE", "FOREIGN", "CONSTRAINT", "CHECK", "INDEX", "KEY", "EXCLUDE",
}
SQL_REF = re.compile(r"REFERENCES\s+([^\s(,)]+)", re.IGNORECASE)


class Module:
    def __init__(self, layer: str, lang: str, path: str, source: str) -> None:
        self.layer = layer
        self.lang = lang
        self.path = path
        self.source = source
        self.node_id = f"{ID_PREFIX[lang]}:{path}"
        self.dirname = path.rsplit("/", 1)[0] if "/" in path else ""

    def __lt__(self, other: "Module") -> bool:
        return self.node_id < other.node_id


# ---------------------------------------------------------------------------
# .gitignore matching
# ---------------------------------------------------------------------------


def _glob_to_regex(pat: str) -> str:
    """Translate a gitignore glob to a regex. `*`/`?` never cross `/`; `**` may."""
    out: list[str] = []
    i = 0
    n = len(pat)
    while i < n:
        c = pat[i]
        if c == "*":
            if i + 1 < n and pat[i + 1] == "*":
                if i + 2 < n and pat[i + 2] == "/":
                    out.append("(?:.*/)?")
                    i += 3
                else:
                    out.append(".*")
                    i += 2
            else:
                out.append("[^/]*")
                i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    return "".join(out)


class Ignores:
    """A small .gitignore matcher. Not git-perfect; covers the common forms."""

    def __init__(self) -> None:
        self._rules: list[tuple[list[str], re.Pattern[str], bool, bool]] = []

    def add(self, dir_relpath: str, text: str) -> None:
        base = [] if not dir_relpath else dir_relpath.split("/")
        for raw in text.splitlines():
            line = raw.rstrip()
            if not line or line.startswith("#"):
                continue
            negate = line.startswith("!")
            if negate:
                line = line[1:]
            dir_only = line.endswith("/")
            if dir_only:
                line = line[:-1]
            anchored = line.startswith("/")
            if anchored:
                line = line[1:]
            if not line:
                continue
            if not anchored and "/" not in line:
                regex = "(?:.*/)?" + _glob_to_regex(line)
            else:
                regex = _glob_to_regex(line)
            self._rules.append((base, re.compile(regex), negate, dir_only))

    def match(self, relpath: str, is_dir: bool) -> bool:
        parts = relpath.split("/")
        ignored = False
        for base, regex, negate, dir_only in self._rules:
            if len(parts) < len(base) or parts[: len(base)] != base:
                continue
            rel = "/".join(parts[len(base):])
            if dir_only and not is_dir:
                continue
            if regex.match(rel):
                ignored = not negate
        return ignored


# ---------------------------------------------------------------------------
# Layer inference
# ---------------------------------------------------------------------------


def infer_layer(relpath: str, lang: str) -> str | None:
    """Infer a layer for a repo-relative file; None means the file is skipped."""
    if lang == "sql":
        return "db"
    dirs = [part.lower() for part in relpath.split("/")[:-1]]
    for d in dirs:
        if d in DB_DIRS:
            return "db"
    for d in dirs:
        if d in FRONTEND_DIRS:
            return "frontend"
    for d in dirs:
        if d in BACKEND_DIRS:
            return "backend"
    if lang in FRONTEND_LANGS:
        return "frontend"
    if lang in BACKEND_LANGS:
        return "backend"
    return None


# ---------------------------------------------------------------------------
# Shared visibility helper
# ---------------------------------------------------------------------------


def _visibility(name: str, explicit: str = "", *, upper_is_public: bool = False) -> str:
    """explicit keyword wins; then Go-style capitalisation; then leading '_'."""
    if explicit in ("public", "private", "protected"):
        return explicit
    if upper_is_public:
        return "public" if name[:1].isupper() else "private"
    return "private" if name.startswith("_") else "public"


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
        "visibility": _visibility(last),
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


def _parse_python(path: str, source: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return [], []
    fields: list[dict[str, Any]] = []
    named: list[tuple[str, ast.AST]] = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            fields.append({"name": node.name, "visibility": _visibility(node.name), "type": "class"})
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
                        {"name": target.id, "visibility": _visibility(target.id), "type": "const"}
                    )
    ids = _unique_ids([n for n, _ in named])
    methods = [_py_method(nid, node) for nid, (_, node) in zip(ids, named)]
    return fields, methods


# ---------------------------------------------------------------------------
# TypeScript / JavaScript / Vue / Svelte parsing (regex)
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


def _balanced(text: str, i: int, open: str, close: str) -> str:
    """Balanced-block content (exclusive of delimiters) starting at text[i]==open."""
    if i < 0 or i >= len(text) or text[i] != open:
        return ""
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
        elif c == open:
            depth += 1
        elif c == close:
            depth -= 1
            if depth == 0:
                return text[i + 1 : j]
        j += 1
    return ""


def _extract_group(text: str, i: int) -> str:
    """Balanced parenthesised group starting at text[i]=='('."""
    return _balanced(text, i, "(", ")")


def _ts_params(group: str, *, last: bool = False) -> str:
    """Parameter names from a raw `(...)` group.

    `last=True` for type-first languages (Java, C#), where `String name` puts
    the name at the end; the default suits `name: Type` and `name Type`.
    """
    if not group:
        return ""
    names = []
    for part in _split_top_level(group):
        if last:
            # `int x = 5` — a default value would otherwise win the last slot.
            part = part.split("=", 1)[0]
        found = re.findall(r"[A-Za-z_$][A-Za-z0-9_$]*", part)
        if found:
            names.append(found[-1] if last else found[0])
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


def _parse_ts(path: str, text: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fields: list[dict[str, Any]] = []
    entries: list[tuple[str, str, str]] = []  # (name, params, visibility)
    for m in TS_EXPORT.finditer(text):
        kind, name = m.group(1), m.group(2)
        line_start = text.rfind("\n", 0, m.start()) + 1
        line_end = text.find("\n", m.end())
        if line_end == -1:
            line_end = len(text)
        line = text[line_start:line_end]
        if kind == "function":
            entries.append((name, _func_params(text, m.end()), _visibility(name)))
        elif kind in ("const", "let", "var"):
            eq = line.find("=")
            arrow = eq != -1 and ("=>" in line or "(" in line[eq:])
            if arrow:
                entries.append((name, _arrow_params(text, line_start, line_end), _visibility(name)))
            else:
                fields.append({"name": name, "visibility": _visibility(name), "type": "const"})
        elif kind == "class":
            fields.append({"name": name, "visibility": _visibility(name), "type": "class"})
            body_start = text.find("{", m.end())
            body = _balanced(text, body_start, "{", "}")
            if body:
                for bm in TS_CLASS_METHOD.finditer(body):
                    mname = bm.group(1)
                    if mname in TS_SKIP_KEYWORDS:
                        continue
                    entries.append(
                        (
                            f"{name}.{mname}",
                            _ts_params(_extract_group(body, bm.end() - 1)),
                            _visibility(mname),
                        )
                    )
        else:
            fields.append({"name": name, "visibility": _visibility(name), "type": kind})
    ids = _unique_ids([e[0] for e in entries])
    methods = [
        {
            "id": nid,
            "kind": "",
            "name": n,
            "visibility": v,
            "returnType": "",
            "params": p,
            "steps": [],
        }
        for nid, (n, p, v) in zip(ids, entries)
    ]
    return fields, methods


def _parse_ts_scripts(path: str, source: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Vue/Svelte: concatenate every <script> block and run the TS parser."""
    combined = "\n".join(m.group(1) for m in SCRIPT_BLOCK.finditer(source))
    return _parse_ts(path, combined)


# ---------------------------------------------------------------------------
# Go parsing (regex)
# ---------------------------------------------------------------------------


def _go_return_type(text: str, close: int) -> str:
    """Return type: text between the params' closing ')' and '{' or EOL."""
    i = close + 1
    while i < len(text) and text[i] in " \t":
        i += 1
    brace = text.find("{", i)
    eol = text.find("\n", i)
    if eol == -1:
        eol = len(text)
    end = brace if brace != -1 and brace < eol else eol
    return text[i:end].strip()


def _parse_go(path: str, source: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fields: list[dict[str, Any]] = []
    entries: list[tuple[str, str, str, str]] = []  # (name, visibility, returnType, params)
    for m in GO_RECEIVER.finditer(source):
        recv, name = m.group(1), m.group(2)
        paren = m.end() - 1
        group = _extract_group(source, paren)
        params = _ts_params(group)
        ret = _go_return_type(source, paren + 1 + len(group))
        entries.append((f"{recv}.{name}", _visibility(name, upper_is_public=True), ret, params))
    for m in GO_FUNC.finditer(source):
        name = m.group(1)
        paren = m.end() - 1
        group = _extract_group(source, paren)
        params = _ts_params(group)
        ret = _go_return_type(source, paren + 1 + len(group))
        entries.append((name, _visibility(name, upper_is_public=True), ret, params))
    ids = _unique_ids([e[0] for e in entries])
    methods = [
        {
            "id": nid,
            "kind": "",
            "name": n,
            "visibility": v,
            "returnType": r,
            "params": p,
            "steps": [],
        }
        for nid, (n, v, r, p) in zip(ids, entries)
    ]
    seen_types: set[str] = set()
    for m in GO_TYPE.finditer(source):
        name = m.group(1)
        seen_types.add(name)
        fields.append(
            {
                "name": name,
                "visibility": _visibility(name, upper_is_public=True),
                "type": m.group(2),
            }
        )
    for m in GO_TYPE_ALIAS.finditer(source):
        name = m.group(1)
        if name in seen_types:
            continue
        seen_types.add(name)
        fields.append(
            {"name": name, "visibility": _visibility(name, upper_is_public=True), "type": "type"}
        )
    for m in GO_CONST.finditer(source):
        tkind, name = m.group(1), m.group(2)
        fields.append(
            {"name": name, "visibility": _visibility(name, upper_is_public=True), "type": tkind}
        )
    return fields, methods


# ---------------------------------------------------------------------------
# Java / Kotlin / C# parsing (regex, shared shape)
# ---------------------------------------------------------------------------


def _jvm_parse(
    text: str,
    type_re: re.Pattern[str],
    method_re: re.Pattern[str] | None,
    explicit_map: dict[str, str] | None = None,
    has_return: bool = True,
    skip: set[str] | None = None,
    type_first: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    explicit_map = explicit_map or {}
    fields: list[dict[str, Any]] = []
    for m in type_re.finditer(text):
        vis = m.group(1) or ""
        vis = explicit_map.get(vis, vis) if vis else vis
        tkind, name = m.group(2), m.group(3)
        fields.append({"name": name, "visibility": _visibility(name, vis), "type": tkind})
    if method_re is None:
        return fields, []
    entries: list[tuple[str, str, str, str]] = []  # (name, visibility, returnType, params)
    for m in method_re.finditer(text):
        vis = m.group(1) or ""
        vis = explicit_map.get(vis, vis) if vis else vis
        if has_return:
            ret, name = m.group(2), m.group(3)
            if (skip and name in skip) or not ret.strip():
                continue
            # A constructor has no return type, so the optional-modifier group
            # goes unmatched and `ret` captures the modifier instead.
            if ret.strip() in VISIBILITY_WORDS:
                vis = vis or explicit_map.get(ret.strip(), ret.strip())
                ret = ""
        else:
            name = m.group(2)
            ret = ""
            if skip and name in skip:
                continue
        entries.append(
            (
                name,
                _visibility(name, vis),
                ret.strip(),
                _ts_params(_extract_group(text, m.end() - 1), last=type_first),
            )
        )
    ids = _unique_ids([e[0] for e in entries])
    methods = [
        {
            "id": nid,
            "kind": "",
            "name": n,
            "visibility": v,
            "returnType": r,
            "params": p,
            "steps": [],
        }
        for nid, (n, v, r, p) in zip(ids, entries)
    ]
    return fields, methods


def _parse_java(path: str, source: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return _jvm_parse(source, JAVA_TYPE, JAVA_METHOD, skip=JVM_SKIP_METHODS, type_first=True)


def _parse_kotlin(path: str, source: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return _jvm_parse(
        source,
        JAVA_TYPE,
        KOTLIN_FUN,
        explicit_map={"internal": "protected"},
        has_return=False,
        skip=JVM_SKIP_METHODS,
    )


def _parse_csharp(path: str, source: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return _jvm_parse(source, CSHARP_TYPE, CSHARP_METHOD, skip=JVM_SKIP_METHODS, type_first=True)


# ---------------------------------------------------------------------------
# Rust parsing (regex)
# ---------------------------------------------------------------------------


def _rust_return(text: str, paren: int) -> str:
    close = paren + 1 + len(_extract_group(text, paren))
    arrow = text.find("->", close)
    if arrow == -1:
        return ""
    i = arrow + 2
    while i < len(text) and text[i] in " \t":
        i += 1
    # `;` and the line end terminate a bodyless trait method, which would
    # otherwise run on to the next `{` several declarations later.
    ends = [
        e
        for e in (
            text.find("{", i),
            text.find("where", i),
            text.find(";", i),
            text.find("\n", i),
        )
        if e != -1
    ]
    end = min(ends) if ends else len(text)
    return text[i:end].strip()


def _parse_rust(path: str, source: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fields: list[dict[str, Any]] = []
    entries: list[tuple[str, str, str, str]] = []  # (name, visibility, returnType, params)
    for m in RUST_TYPE.finditer(source):
        pub, tkind, name = m.group(1), m.group(2), m.group(3)
        fields.append({"name": name, "visibility": "public" if pub else "private", "type": tkind})
    for m in RUST_CONST.finditer(source):
        pub, tkind, name = m.group(1), m.group(2), m.group(3)
        fields.append({"name": name, "visibility": "public" if pub else "private", "type": tkind})
    for m in RUST_FN.finditer(source):
        pub, name = m.group(1), m.group(2)
        i = m.end()
        while i < len(source) and source[i] in " \t":
            i += 1
        if i < len(source) and source[i] == "<":
            depth = 0
            while i < len(source):
                if source[i] == "<":
                    depth += 1
                elif source[i] == ">":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
            while i < len(source) and source[i] in " \t":
                i += 1
        if i >= len(source) or source[i] != "(":
            continue
        params = _ts_params(_extract_group(source, i))
        ret = _rust_return(source, i)
        entries.append((name, "public" if pub else "private", ret, params))
    ids = _unique_ids([e[0] for e in entries])
    methods = [
        {
            "id": nid,
            "kind": "",
            "name": n,
            "visibility": v,
            "returnType": r,
            "params": p,
            "steps": [],
        }
        for nid, (n, v, r, p) in zip(ids, entries)
    ]
    return fields, methods


# ---------------------------------------------------------------------------
# Ruby parsing (regex)
# ---------------------------------------------------------------------------


def _ruby_params(text: str, name_end: int) -> str:
    i = name_end
    while i < len(text) and text[i] in " \t":
        i += 1
    if i < len(text) and text[i] == "(":
        return _ts_params(_extract_group(text, i))
    eol = text.find("\n", i)
    if eol == -1:
        eol = len(text)
    return _ts_params(text[i:eol])


def _parse_ruby(path: str, source: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fields: list[dict[str, Any]] = []
    entries: list[tuple[str, str, str]] = []  # (name, visibility, params)
    for m in RUBY_TYPE.finditer(source):
        tkind, name = m.group(1), m.group(2)
        fields.append({"name": name, "visibility": _visibility(name), "type": tkind})
    for m in RUBY_CONST.finditer(source):
        name = m.group(1)
        fields.append({"name": name, "visibility": _visibility(name), "type": "const"})
    for m in RUBY_DEF.finditer(source):
        name = m.group(1)
        entries.append((name, _visibility(name), _ruby_params(source, m.end())))
    ids = _unique_ids([e[0] for e in entries])
    methods = [
        {
            "id": nid,
            "kind": "",
            "name": n,
            "visibility": v,
            "returnType": "",
            "params": p,
            "steps": [],
        }
        for nid, (n, v, p) in zip(ids, entries)
    ]
    return fields, methods


# ---------------------------------------------------------------------------
# PHP parsing (regex)
# ---------------------------------------------------------------------------


def _parse_php(path: str, source: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fields: list[dict[str, Any]] = []
    entries: list[tuple[str, str, str]] = []  # (name, visibility, params)
    for m in PHP_TYPE.finditer(source):
        tkind, name = m.group(1), m.group(2)
        fields.append({"name": name, "visibility": _visibility(name), "type": tkind})
    for m in PHP_PROP.finditer(source):
        vis, name = m.group(1), m.group(2)
        fields.append({"name": name, "visibility": _visibility(name, vis), "type": "field"})
    for m in PHP_FUN.finditer(source):
        vis, name = m.group(1), m.group(2)
        params = _ts_params(_extract_group(source, m.end() - 1))
        entries.append((name, _visibility(name, vis or ""), params))
    ids = _unique_ids([e[0] for e in entries])
    methods = [
        {
            "id": nid,
            "kind": "",
            "name": n,
            "visibility": v,
            "returnType": "",
            "params": p,
            "steps": [],
        }
        for nid, (n, v, p) in zip(ids, entries)
    ]
    return fields, methods


# ---------------------------------------------------------------------------
# SQL -> table nodes in the db layer
# ---------------------------------------------------------------------------


def _strip_quotes(s: str) -> str:
    if len(s) >= 2:
        if s[0] == "`" and s[-1] == "`":
            return s[1:-1]
        if s[0] == '"' and s[-1] == '"':
            return s[1:-1]
        if s[0] == "[" and s[-1] == "]":
            return s[1:-1]
    return s


def _sql_type_and_rest(rest: str) -> tuple[str, str]:
    """Split `VARCHAR(255) NOT NULL` into ('VARCHAR(255)', 'NOT NULL')."""
    rest = rest.strip()
    if not rest:
        return "", ""
    # Stop at `(` as well as whitespace, so `NUMERIC(10, 2)` keeps its size
    # list instead of being cut at the comma by the caller's tokenizer.
    m = re.match(r"[^\s(]+", rest)
    typ = m.group(0)
    i = m.end()
    if i < len(rest) and rest[i] == "(":
        inner = _balanced(rest, i, "(", ")")
        typ += "(" + inner + ")"
        i = i + 2 + len(inner)
    return typ, rest[i:].strip()


def _parse_sql_column(part: str) -> tuple[str, str, str] | None:
    """Parse one top-level fragment of a CREATE TABLE body.

    Returns None for table-level constraints; otherwise (name, type,
    constraint).
    """
    text = part.strip()
    if not text:
        return None
    m = re.match(r"(`[^`]+`|\"[^\"]+\"|\[[^\]]+\]|[A-Za-z_][\w]*)\s*(.*)$", text, re.DOTALL)
    if not m:
        return None
    first, rest = m.group(1), m.group(2)
    if first[0] not in "`\"[":
        if first.upper() in SQL_TABLE_CONSTRAINTS:
            return None
    name = _strip_quotes(first)
    typ, remainder = _sql_type_and_rest(rest)
    constraint = " ".join(remainder.split())
    return name, typ, constraint


def build_sql_graph(
    mods: list[Module],
    edge_ids: set[str],
    warnings: list[str],
) -> dict[str, Any]:
    tables_by_name: dict[str, list[str]] = {}
    # A FK is commonly written twice (inline REFERENCES plus a table-level
    # FOREIGN KEY); one relation should still be one edge.
    fk_refs: set[tuple[str, str]] = set()
    table_nodes: list[dict[str, Any]] = []
    for m in sorted(mods):
        for m2 in SQL_CREATE.finditer(m.source):
            raw_name = m2.group(1).strip()
            table_name = _strip_quotes(raw_name)
            node_id = f"tbl:{m.path}#{table_name}"
            tables_by_name.setdefault(table_name.split(".")[-1].lower(), []).append(node_id)
            body = _balanced(m.source, m2.end() - 1, "(", ")")
            columns: list[dict[str, str]] = []
            for part in _split_top_level(body):
                ref = SQL_REF.search(part)
                col = _parse_sql_column(part)
                if col is None:
                    if ref:
                        fk_refs.add((node_id, _strip_quotes(ref.group(1))))
                    continue
                name, typ, constraint = col
                if ref:
                    fk_refs.add((node_id, _strip_quotes(ref.group(1))))
                columns.append({"name": name, "type": typ, "constraint": constraint})
            table_nodes.append(
                {
                    "id": node_id,
                    "type": "table",
                    "position": {"x": 0, "y": 0},
                    "data": {
                        "label": table_name,
                        "path": m.path,
                        "description": "",
                        "columns": columns,
                    },
                    "style": MODULE_STYLE,
                }
            )
    for key, ids in sorted(tables_by_name.items()):
        if len(ids) > 1:
            warnings.append(
                f"table '{key}' defined in multiple SQL files: {', '.join(sorted(ids))}"
            )
    table_nodes.sort(key=lambda n: n["id"])
    for i, n in enumerate(table_nodes):
        n["position"] = {"x": (i % 4) * COLUMN_W, "y": (i // 4) * ROW_STEP}
    edges: list[dict[str, Any]] = []
    for src, target in sorted(fk_refs):
        ids = tables_by_name.get(target.split(".")[-1].lower())
        if not ids:
            continue
        dst = min(ids)
        edges.append(_make_edge(src, dst, "depends-on", "foreign-key", edge_ids))
    edges.sort(key=lambda e: e["id"])
    return {"nodes": table_nodes, "edges": edges}


# ---------------------------------------------------------------------------
# Dependency edges
# ---------------------------------------------------------------------------


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


def _python_deps(path: str, source: str) -> list[list[str]]:
    deps: list[list[str]] = []
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return deps
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                deps.extend(_py_candidates(path, 0, alias.name, None))
        elif isinstance(node, ast.ImportFrom):
            deps.extend(_py_candidates(path, node.level, node.module, node.names))
    return deps


def _ts_deps(path: str, source: str) -> list[list[str]]:
    base_dir = path.rsplit("/", 1)[0] if "/" in path else ""
    deps: list[list[str]] = []
    for m in TS_IMPORT.finditer(source):
        spec = m.group(1)
        if not spec.startswith("."):
            continue
        combined = posixpath.normpath(posixpath.join(base_dir, spec))
        cands = [combined]
        if not combined.endswith(TS_EXTENSIONS):
            cands += [combined + e for e in TS_EXTENSIONS]
            cands += [combined + i for i in TS_INDEX_FILES]
        deps.append(cands)
    return deps


def _read_go_module(root: Path) -> str:
    gomod = root / "go.mod"
    if not gomod.is_file():
        return ""
    try:
        lines = gomod.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return ""
    for line in lines:
        m = re.match(r"^\s*module\s+(\S+)", line)
        if m:
            return m.group(1)
    return ""


def _make_go_deps(module: str, go_files_by_dir: dict[str, list[str]]):
    """Go deps bound to a go.mod module name; candidates are .go files per dir."""
    prefix = module + "/"

    def go_deps(path: str, source: str) -> list[list[str]]:
        deps: list[list[str]] = []
        for m in re.finditer(r'^\s*"([^"]+)"', source, re.MULTILINE):
            spec = m.group(1)
            if not spec.startswith(prefix):
                continue
            rest = spec[len(prefix):]
            if not rest:
                continue
            files = sorted(go_files_by_dir.get(rest, []))
            if files:
                deps.append([f"{rest}/{f}" for f in files])
        return deps

    return go_deps


def _java_deps(path: str, source: str) -> list[list[str]]:
    deps: list[list[str]] = []
    for m in re.finditer(r"^import\s+(?:static\s+)?([\w.]+)", source, re.MULTILINE):
        dotted = m.group(1).rstrip(".")
        pathpart = dotted.replace(".", "/")
        cands = [f"{pathpart}.java", f"{pathpart}.kt"]
        for src_root in ("src/main/java/", "src/main/kotlin/", "src/"):
            cands += [f"{src_root}{pathpart}.java", f"{src_root}{pathpart}.kt"]
        deps.append(cands)
    return deps


def _rust_deps(path: str, source: str) -> list[list[str]]:
    dirpath = path.rsplit("/", 1)[0] if "/" in path else ""
    deps: list[list[str]] = []
    for m in re.finditer(r"^\s*(?:pub\s+)?mod\s+(\w+)\s*;", source, re.MULTILINE):
        name = m.group(1)
        deps.append([f"{dirpath}/{name}.rs", f"{dirpath}/{name}/mod.rs"])
    for m in re.finditer(r"^\s*use\s+crate::([\w:]+)", source, re.MULTILINE):
        rest = m.group(1).replace(":", "/")
        parts = rest.split("/")
        cands: list[str] = []
        for k in range(len(parts), 0, -1):
            prefix = "/".join(parts[:k])
            cands.append(f"src/{prefix}.rs")
            cands.append(f"src/{prefix}/mod.rs")
        deps.append(cands)
    return deps


def _ruby_deps(path: str, source: str) -> list[list[str]]:
    dirpath = path.rsplit("/", 1)[0] if "/" in path else ""
    deps: list[list[str]] = []
    for m in re.finditer(r"require_relative\s+['\"]([^'\"]+)['\"]", source):
        spec = m.group(1)
        combined = posixpath.normpath(posixpath.join(dirpath, spec))
        deps.append([f"{combined}.rb"])
    return deps


def _php_deps(path: str, source: str) -> list[list[str]]:
    dirpath = path.rsplit("/", 1)[0] if "/" in path else ""
    deps: list[list[str]] = []
    for m in re.finditer(r"require(?:_once)?\s*\(?\s*['\"]([^'\"]+)['\"]", source):
        spec = m.group(1)
        combined = posixpath.normpath(posixpath.join(dirpath, spec))
        deps.append([combined, f"{combined}.php"])
    return deps


def _no_deps(path: str, source: str) -> list[list[str]]:
    return []


PARSERS = {
    "python": _parse_python,
    "typescript": _parse_ts,
    "javascript": _parse_ts,
    "vue": _parse_ts_scripts,
    "svelte": _parse_ts_scripts,
    "go": _parse_go,
    "java": _parse_java,
    "kotlin": _parse_kotlin,
    "csharp": _parse_csharp,
    "rust": _parse_rust,
    "ruby": _parse_ruby,
    "php": _parse_php,
}

DEPS = {
    "python": _python_deps,
    "typescript": _ts_deps,
    "javascript": _ts_deps,
    "vue": _ts_deps,
    "svelte": _ts_deps,
    "go": _no_deps,
    "java": _java_deps,
    "kotlin": _java_deps,
    "csharp": _no_deps,
    "rust": _rust_deps,
    "ruby": _ruby_deps,
    "php": _php_deps,
    "sql": _no_deps,
}


# ---------------------------------------------------------------------------
# Graph assembly
# ---------------------------------------------------------------------------


def parse_module(m: Module) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return PARSERS[m.lang](m.path, m.source)


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
    deps_registry: dict[str, Any],
    root_name: str,
) -> dict[str, Any]:
    by_dir: dict[str, list[Module]] = {}
    for m in mods:
        by_dir.setdefault(m.dirname, []).append(m)
    dirs = sorted(by_dir)
    container_dirs = [] if len(dirs) <= 1 else dirs

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
        label = root_name if d == "" else d.rsplit("/", 1)[-1]
        nodes.append(
            {
                "id": cid,
                "type": "service",
                "position": {"x": positions[cid][0], "y": positions[cid][1]},
                "data": {"label": label, "path": d, "description": ""},
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
        deps = _module_deps(m, modules_by_path, layer, skipped, deps_registry)
        for target in sorted(deps):
            edges.append(_make_edge(m.node_id, target, "depends-on", "in-process", edge_ids))
    edges.sort(key=lambda e: e["id"])
    return {"nodes": nodes, "edges": edges}


def _module_deps(
    m: Module,
    modules_by_path: dict[str, Module],
    layer: str,
    skipped: list[dict[str, str]],
    deps_registry: dict[str, Any],
) -> set[str]:
    deps = deps_registry[m.lang](m.path, m.source)
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


def _read_utf8(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def scan(root: Path, max_files: int = DEFAULT_MAX_FILES) -> tuple[list[Module], dict[str, Module], dict[str, Any]]:
    ignores = Ignores()
    modules: list[Module] = []
    by_path: dict[str, Module] = {}
    stats: dict[str, Any] = {
        "files_scanned": 0,
        "files_skipped": 0,
        "by_language": {},
        "by_layer": {},
    }

    root_gitignore = root / ".gitignore"
    if root_gitignore.is_file():
        ignores.add("", _read_utf8(root_gitignore))

    for dirpath, dirnames, filenames in os.walk(root, onerror=lambda _err: None):
        dir_obj = Path(dirpath)
        rel_dir = "" if dir_obj == root else dir_obj.relative_to(root).as_posix()
        gi = dir_obj / ".gitignore"
        if gi.is_file():
            ignores.add(rel_dir, _read_utf8(gi))
        kept: list[str] = []
        for name in dirnames:
            if name in SKIP_DIRS or name.startswith("."):
                continue
            child_rel = f"{rel_dir}/{name}" if rel_dir else name
            if ignores.match(child_rel, is_dir=True):
                continue
            kept.append(name)
        dirnames[:] = kept
        for fname in filenames:
            rel = f"{rel_dir}/{fname}" if rel_dir else fname
            lang = LANGUAGES.get(Path(fname).suffix.lower())
            if lang is None:
                continue
            if ignores.match(rel, is_dir=False):
                stats["files_skipped"] += 1
                continue
            fpath = dir_obj / fname
            try:
                if fpath.stat().st_size > MAX_FILE_BYTES:
                    stats["files_skipped"] += 1
                    continue
            except OSError:
                stats["files_skipped"] += 1
                continue
            try:
                source = fpath.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                stats["files_skipped"] += 1
                continue
            layer = infer_layer(rel, lang)
            if layer is None:
                stats["files_skipped"] += 1
                continue
            stats["files_scanned"] += 1
            stats["by_language"][lang] = stats["by_language"].get(lang, 0) + 1
            stats["by_layer"][layer] = stats["by_layer"].get(layer, 0) + 1
            if stats["files_scanned"] > max_files:
                raise ScanLimitError(
                    f"scan limit exceeded: {stats['files_scanned']} source files, "
                    f"limit {max_files}"
                )
            m = Module(layer, lang, rel, source)
            modules.append(m)
            by_path[rel] = m
    modules.sort()
    return modules, by_path, stats


def build(root: Path, max_files: int = DEFAULT_MAX_FILES) -> dict[str, Any]:
    modules, by_path, stats = scan(root, max_files)
    edge_ids: set[str] = set()
    skipped: list[dict[str, str]] = []
    warnings: list[str] = []

    deps_registry = dict(DEPS)
    go_module = _read_go_module(root)
    if go_module:
        go_files_by_dir: dict[str, list[str]] = {}
        for m in modules:
            if m.lang == "go":
                go_files_by_dir.setdefault(m.dirname, []).append(m.path.rsplit("/", 1)[-1])
        deps_registry["go"] = _make_go_deps(go_module, go_files_by_dir)

    sql_mods = [m for m in modules if m.lang == "sql"]
    mods = [m for m in modules if m.lang != "sql"]
    graphs: dict[str, Any] = {}
    for layer in LAYER_NAMES:
        if layer == "db":
            graphs[layer] = build_sql_graph(sql_mods, edge_ids, warnings)
        else:
            layer_mods = [m for m in mods if m.layer == layer]
            graphs[layer] = build_layer(
                layer, layer_mods, by_path, edge_ids, skipped, deps_registry, root.name
            )

    for layer in LAYER_NAMES:
        n = len(graphs[layer]["nodes"])
        if n > 300:
            warnings.append(f"layer {layer} exceeds 300 nodes ({n})")

    skipped.sort(key=lambda s: (s["source"], s["target"], s["reason"]))
    if skipped:
        warnings.append(f"{len(skipped)} cross-layer import(s) skipped")

    node_count = sum(len(g["nodes"]) for g in graphs.values())
    edge_count = sum(len(g["edges"]) for g in graphs.values())

    stats_out: dict[str, Any] = {
        "files_scanned": stats["files_scanned"],
        "files_skipped": stats["files_skipped"],
        "by_language": {k: v for k, v in sorted(stats["by_language"].items()) if v},
        "by_layer": {k: stats["by_layer"].get(k, 0) for k in LAYER_NAMES},
        "node_count": node_count,
        "edge_count": edge_count,
        "warnings": sorted(warnings),
    }
    return {
        "metaspecs_import": 1,
        "root": root.name,
        "graphs": graphs,
        "skipped_cross_layer": skipped,
        "stats": stats_out,
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
    parser.add_argument(
        "--max-files",
        type=int,
        default=DEFAULT_MAX_FILES,
        help=f"max accepted source files before raising ScanLimitError "
             f"(default: {DEFAULT_MAX_FILES})",
    )
    parser.add_argument("--push", default=None, help="project id to POST the graphs to")
    parser.add_argument("--api", default="http://localhost:8000", help="API base URL")
    args = parser.parse_args(argv)

    root = (
        Path(args.root).resolve()
        if args.root
        else Path(__file__).resolve().parents[1]
    )
    try:
        data = build(root, args.max_files)
    except ScanLimitError as exc:
        print(str(exc), file=sys.stderr)
        return 2
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
