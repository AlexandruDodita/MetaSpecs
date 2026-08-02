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
# File nodes must not be emitted smaller than their CSS minimum (320x200 in
# index.css): React Flow's box tracks node.style, so a smaller style leaves
# the drag/resize box smaller than the rendered object.
FILE_STYLE = {"width": 320, "height": 240}
CONTAINER_STYLE = {"width": 320, "height": 240}

TS_EXPORT = re.compile(
    r"^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?"
    r"(function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)",
    re.MULTILINE,
)
TS_IMPORT = re.compile(r"(?:from|import)\s*['\"]([^'\"]+)['\"]")
TS_IMPORT_STMT = re.compile(r"^\s*import\s+(?:type\s+)?(.*?)\s+from\s+['\"]([^'\"]+)['\"]", re.MULTILINE)
TS_CLASS_METHOD = re.compile(
    r"^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?"
    r"([A-Za-z_$][\w$]*)\s*\(",
    re.MULTILINE,
)
TS_SKIP_KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "function", "super", "this"}
TS_CALL = re.compile(r"([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(")
TS_BARE_CALL = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(")
TS_CALL_SKIP = {
    "if", "for", "while", "switch", "catch", "return", "new", "typeof",
    "instanceof", "delete", "void", "await", "yield", "in", "of", "do",
    "else", "case", "function", "class", "import", "export", "extends",
    "throw", "debugger", "satisfies", "as", "from", "super",
}
JS_DOC = re.compile(r"/\*\*([\s\S]*?)\*/")
TS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte")
TS_INDEX_FILES = ("/index.ts", "/index.tsx", "/index.js", "/index.jsx")
SCRIPT_BLOCK = re.compile(r"<script\b[^>]*>(.*?)</script>", re.DOTALL)


def _clean_jsdoc(body: str) -> str:
    lines = []
    for raw in body.splitlines():
        ln = raw.strip().lstrip("*").strip()
        if ln:
            lines.append(ln)
    return "\n".join(lines).strip()


def _pair_docs(text: str, decls: list[tuple[int, Any]]) -> dict[Any, str]:
    """Map each declaration start to the /** */ block directly above it.

    decls are (position, key) pairs; the block must end before the position
    with only whitespace in between. Keys may be any hashable (an int start
    for class-body methods, a (kind, name) tuple for top-level exports).
    """
    blocks = [(m.start(), m.end(), _clean_jsdoc(m.group(1))) for m in JS_DOC.finditer(text)]
    out: dict[Any, str] = {}
    bi = 0
    for start, key in sorted(decls):
        best = None
        while bi < len(blocks) and blocks[bi][1] <= start:
            best = blocks[bi]
            bi += 1
        if best is not None and not text[best[1]:start].strip():
            out[key] = best[2]
    return out


def _ts_module_note(text: str, first_decl_start: int | None) -> str:
    if first_decl_start is None:
        return ""
    first = JS_DOC.search(text)
    if first is None or first.end() > first_decl_start:
        return ""
    return _clean_jsdoc(first.group(1))


def _ts_imports(text: str) -> dict[str, tuple[str, str]]:
    """{bound name: (spec, kind)} for relative imports; kind: namespace|named."""
    imports: dict[str, tuple[str, str]] = {}
    for m in TS_IMPORT_STMT.finditer(text):
        body, spec = m.group(1).strip(), m.group(2)
        if not spec.startswith("."):
            continue
        if body.startswith("*"):
            star = re.match(r"\*\s*as\s+([A-Za-z_$][\w$]*)", body)
            if star:
                imports[star.group(1)] = (spec, "namespace")
            continue
        if body.startswith("{"):
            inner = body[1:]
            if inner.endswith("}"):
                inner = inner[:-1]
            body = inner
        for part in _split_top_level(body):
            part = re.sub(r"\btype\b", "", part).strip()
            m2 = re.match(r"^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$", part)
            if not m2:
                continue
            imports[m2.group(2) or m2.group(1)] = (spec, "named")
    return imports


def _strip_ts_text(text: str) -> str:
    """Blank strings and comments (positions preserved) so call regexes don't
    match inside them."""
    out: list[str] = []
    i, n = 0, len(text)
    in_str: str | None = None
    while i < n:
        c = text[i]
        if in_str is not None:
            out.append(" ")
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in ("'", '"', "`"):
            in_str = c
            out.append(" ")
        elif c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            j = n if j == -1 else j
            out.append(" " * (j - i))
            i = j
            continue
        elif c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            j = n if j == -1 else j + 2
            out.append(" " * (j - i))
            i = j
            continue
        else:
            out.append(c)
        i += 1
    return "".join(out)

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


def _py_doc(node: ast.AST) -> str:
    try:
        doc = ast.get_docstring(node, clean=True)
    except Exception:
        return ""
    return "" if not doc else doc


def _py_aliases(tree: ast.Module, path: str) -> dict[str, tuple[str, str | None]]:
    """Top-level imports as {bound name: (dotted module, symbol | None)}.

    `import a.b` binds the top name; `from x.y import z as w` binds w to
    symbol z of module x.y. Symbols with the same name as a submodule resolve
    as the module first (callers try both).
    """
    base_parts = path[:-3].split("/") if path.endswith(".py") else []
    aliases: dict[str, tuple[str, str | None]] = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for a in node.names:
                aliases[a.asname or a.name.split(".")[0]] = (a.name, None)
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if node.level:
                drop = min(node.level, len(base_parts))
                base = ".".join(base_parts[: len(base_parts) - drop])
                mod = f"{base}.{mod}" if base and mod else base or mod
            for a in node.names:
                if a.name == "*":
                    continue
                aliases[a.asname or a.name] = (mod, a.name)
    return aliases


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


def _parse_python(
    path: str, source: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    """(fields, methods, notes, aux) — methods carry 'owner' (class or ''),
    notes has 'module'/'classes' docstrings, aux holds the AST for calls."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return [], [], {"module": "", "classes": {}}, {}
    fields: list[dict[str, Any]] = []
    classes: dict[str, ast.ClassDef] = {}
    module_funcs: list[ast.AST] = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            classes[node.name] = node
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            module_funcs.append(node)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name) and target.id.isupper():
                    fields.append(
                        {"name": target.id, "visibility": _visibility(target.id), "type": "const"}
                    )
    named: list[tuple[str, str, ast.AST]] = []
    for name, cdef in classes.items():
        for item in cdef.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                named.append((f"{name}.{item.name}", name, item))
    for item in module_funcs:
        named.append((item.name, "", item))
    ids = _unique_ids([n for n, _, _ in named])
    methods = []
    for nid, (name, owner, node) in zip(ids, named):
        last = name.split(".")[-1]
        methods.append(
            {
                "id": nid,
                "kind": "",
                "name": name,
                "visibility": _visibility(last),
                "returnType": _annotation(node.returns),
                "params": _params(node.args),
                "steps": [],
                "notes": _py_doc(node),
                "owner": owner,
            }
        )
    notes = {"module": _py_doc(tree), "classes": {n: _py_doc(c) for n, c in classes.items()}}
    functions = [(owner, name, node) for name, owner, node in named]
    return fields, methods, notes, {"functions": functions, "aliases": _py_aliases(tree, path)}


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


def _func_paren(text: str, name_end: int) -> int:
    """Position of the '(' opening a function's params, or -1."""
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
    return i if i < len(text) and text[i] == "(" else -1


def _ts_body_span(text: str, decl_start: int, paren: int | None) -> tuple[int, int] | None:
    """(start, end) of a function/class-method body, or an arrow's braces.

    `paren` is the '(' position for regular declarations; None means an
    arrow (`=> { ... }`, braces required).
    """
    if paren is not None:
        j = paren + 1 + len(_extract_group(text, paren))
        if j < len(text) and text[j] == ")":
            j += 1
    else:
        eq = text.find("=>", decl_start)
        if eq == -1:
            return None
        j = eq + 2
        while j < len(text) and text[j] in " \t":
            j += 1
        if j >= len(text):
            return None
        # Arrow bodies may be brace blocks or parenthesised expressions.
        if text[j] == "{":
            return (decl_start, j + 2 + len(_balanced(text, j, "{", "}")))
        if text[j] == "(":
            return (decl_start, j + 1 + len(_balanced(text, j, "(", ")")))
        return None
    while j < len(text) and text[j] in " \t":
        j += 1
    if j < len(text) and text[j] == ":":
        # Skip a TS return type annotation between params and the body.
        j += 1
        depth = 0
        angle = 0
        while j < len(text):
            c = text[j]
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            elif c == "<":
                angle += 1
            elif c == ">":
                angle -= 1
            elif c == "{" and depth <= 0 and angle <= 0:
                break
            j += 1
        if j >= len(text):
            return None
    while j < len(text) and text[j] in " \t":
        j += 1
    if j < len(text) and text[j] == "{":
        return (decl_start, j + 2 + len(_balanced(text, j, "{", "}")))
    return None


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


def _parse_ts(
    path: str, text: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    entries: list[tuple[str, str, str, str, str]] = []  # (name, params, vis, owner, note)
    exports: dict[str, str] = {}
    class_methods: dict[str, set[str]] = {}
    spans: dict[str, tuple[int, int]] = {}
    export_decls: list[tuple[int, Any]] = []
    for m in TS_EXPORT.finditer(text):
        export_decls.append((m.start(), (m.group(1), m.group(2))))
    docmap = _pair_docs(text, export_decls)
    module_note = _ts_module_note(text, export_decls[0][0] if export_decls else None)
    for m in TS_EXPORT.finditer(text):
        kind, name = m.group(1), m.group(2)
        note = docmap.get((kind, name), "")
        line_start = text.rfind("\n", 0, m.start()) + 1
        line_end = text.find("\n", m.end())
        if line_end == -1:
            line_end = len(text)
        line = text[line_start:line_end]
        if kind == "function":
            entries.append((name, _func_params(text, m.end()), _visibility(name), "", note))
            exports[name] = "func"
            paren = _func_paren(text, m.end())
            if paren >= 0:
                span = _ts_body_span(text, m.start(), paren)
                if span:
                    spans[name] = span
        elif kind in ("const", "let", "var"):
            eq = line.find("=")
            arrow = eq != -1 and ("=>" in line or "(" in line[eq:])
            if arrow:
                entries.append((name, _arrow_params(text, line_start, line_end), _visibility(name), "", note))
                exports[name] = "func"
                span = _ts_body_span(text, m.start(), None)
                if span:
                    spans[name] = span
            else:
                fields.append({"name": name, "visibility": _visibility(name), "type": "const"})
        elif kind == "class":
            class_methods[name] = set()
            exports[name] = "class"
            body_start = text.find("{", m.end())
            body = _balanced(text, body_start, "{", "}")
            if body:
                method_decls = []
                for bm in TS_CLASS_METHOD.finditer(body):
                    if bm.group(1) in TS_SKIP_KEYWORDS:
                        continue
                    method_decls.append((body_start + 1 + bm.start(), bm.start()))
                method_docs = _pair_docs(text, method_decls)
                for bm in TS_CLASS_METHOD.finditer(body):
                    mname = bm.group(1)
                    if mname in TS_SKIP_KEYWORDS:
                        continue
                    class_methods[name].add(mname)
                    entries.append(
                        (
                            f"{name}.{mname}",
                            _ts_params(_extract_group(body, bm.end() - 1)),
                            _visibility(mname),
                            name,
                            method_docs.get(bm.start(), ""),
                        )
                    )
                    span = _ts_body_span(text, body_start + 1 + bm.start(), body_start + bm.end())
                    if span:
                        spans[f"{name}.{mname}"] = span
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
            "notes": note,
            "owner": owner,
        }
        for nid, (n, p, v, owner, note) in zip(ids, entries)
    ]
    notes = {"module": module_note, "classes": {}}
    for cls_name in class_methods:
        notes["classes"][cls_name] = ""
    # class notes from the export docmap
    for m in TS_EXPORT.finditer(text):
        if m.group(1) == "class":
            notes["classes"][m.group(2)] = docmap.get(("class", m.group(2)), "")
    aux = {"exports": exports, "classes": class_methods, "imports": _ts_imports(text), "spans": spans}
    return fields, methods, notes, aux


def _parse_ts_scripts(
    path: str, source: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
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


def _parse_go(
    path: str, source: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
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
            "notes": "",
            "owner": "",
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
    return fields, methods, EMPTY_NOTES, EMPTY_AUX


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
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    explicit_map = explicit_map or {}
    fields: list[dict[str, Any]] = []
    for m in type_re.finditer(text):
        vis = m.group(1) or ""
        vis = explicit_map.get(vis, vis) if vis else vis
        tkind, name = m.group(2), m.group(3)
        fields.append({"name": name, "visibility": _visibility(name, vis), "type": tkind})
    if method_re is None:
        return fields, [], EMPTY_NOTES, EMPTY_AUX
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
            "notes": "",
            "owner": "",
        }
        for nid, (n, v, r, p) in zip(ids, entries)
    ]
    return fields, methods, EMPTY_NOTES, EMPTY_AUX


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
            "notes": "",
            "owner": "",
        }
        for nid, (n, v, r, p) in zip(ids, entries)
    ]
    return fields, methods, EMPTY_NOTES, EMPTY_AUX


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
            "notes": "",
            "owner": "",
        }
        for nid, (n, v, p) in zip(ids, entries)
    ]
    return fields, methods, EMPTY_NOTES, EMPTY_AUX


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
            "notes": "",
            "owner": "",
        }
        for nid, (n, v, p) in zip(ids, entries)
    ]
    return fields, methods, EMPTY_NOTES, EMPTY_AUX


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


# Parsers that don't extract docstrings still speak the 4-tuple contract.
EMPTY_NOTES: dict[str, Any] = {"module": "", "classes": {}}
EMPTY_AUX: dict[str, Any] = {}


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
# Call-graph extraction (workflow edges, kind="calls")
# ---------------------------------------------------------------------------
#
# Both languages share a registry {rel path: {"classes": {name: {"methods":
# set, "node": id}}, "funcs": {name: node id}}}. A call resolves to the class
# node of the callee method/class or the file node of a module-level function.
# Calls inside the same module are skipped: the file's own tree already shows
# them. Resolution is conservative — anything ambiguous simply yields no edge.


def _py_chain(func: ast.AST) -> list[str] | None:
    """Dotted chain of a call func; None for dynamic/locally-scoped calls."""
    parts: list[str] = []
    node = func
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return list(reversed(parts))
    return None


def _py_module_target(
    mod_path: str, rest: list[str], caller_path: str, registry: dict[str, Any]
) -> tuple[str, str] | None:
    if mod_path == caller_path or mod_path not in registry:
        return None
    reg = registry[mod_path]
    if len(rest) == 1:
        name = rest[0]
        cls = reg["classes"].get(name)
        if cls is not None:
            return cls["node"], name
        fid = reg["funcs"].get(name)
        if fid is not None:
            return fid, name
        return None
    if len(rest) == 2:
        cls, meth = rest
        c = reg["classes"].get(cls)
        if c is not None and meth in c["methods"]:
            return c["node"], meth
        return None
    return None


def _py_target(
    mod: str, sym: str | None, rest: list[str], caller_path: str, registry: dict[str, Any]
) -> tuple[str, str] | None:
    """Resolve against module `mod` (dotted): `sym` may be a submodule or a
    symbol inside it; `rest` is the un-walked part of the call chain."""
    if sym is not None:
        sub = _dotted_to_path(f"{mod}.{sym}" if mod else sym)
        if sub in registry:
            return _py_module_target(sub, rest, caller_path, registry)
    mod_path = _dotted_to_path(mod) if mod else ""
    if mod_path and mod_path in registry and mod_path != caller_path:
        reg = registry[mod_path]
        cls = reg["classes"].get(sym) if sym is not None else None
        if cls is not None:
            if not rest:
                return cls["node"], sym
            if len(rest) == 1 and rest[0] in cls["methods"]:
                return cls["node"], rest[0]
            return None
        fid = reg["funcs"].get(sym) if sym is not None else None
        if fid is not None and not rest:
            return fid, sym
    return None


def _resolve_py_call(
    chain: list[str], module_path: str, aliases: dict[str, tuple[str, str | None]],
    registry: dict[str, Any],
) -> tuple[str, str] | None:
    if len(chain) == 1:
        name = chain[0]
        if name in ("self", "cls", "super"):
            return None
        alias = aliases.get(name)
        if alias is None:
            return None
        mod, sym = alias
        if sym is None:
            return None
        return _py_target(mod, sym, [], module_path, registry)
    base = chain[0]
    if base in ("self", "cls", "super"):
        return None
    alias = aliases.get(base)
    if alias is None:
        return None
    mod, sym = alias
    if sym is None:
        tail = mod.split(".")[1:]
        rest = chain[1:]
        if rest[: len(tail)] == tail:
            rest = rest[len(tail):]
        return _py_module_target(_dotted_to_path(mod), rest, module_path, registry)
    return _py_target(mod, sym, chain[1:], module_path, registry)


def _callee_display(target_id: str, callee: str) -> str:
    """Human-readable callee for a resolved target node: 'storage.read_graph'
    for a module function, 'Project.info' / 'Project' for class targets."""
    if "#" in target_id:
        cls = target_id.rsplit("#", 1)[1]
        return callee if callee == cls else f"{cls}.{callee}"
    stem = target_id.rsplit(":", 1)[-1].rsplit("/", 1)[-1]
    if stem.endswith(".py"):
        stem = stem[:-3]
    return f"{stem}.{callee}"


def _collect_py_calls(
    m: Module,
    aux: dict[str, Any],
    registry: dict[str, Any],
    calls: dict[tuple[str, str], set[str]],
    method_calls: dict[tuple[str, str], set[str]],
) -> None:
    aliases = aux["aliases"]
    for owner, fname, fnode in aux["functions"]:
        key = f"{owner}.{fname}" if owner else fname
        callees: set[str] = set()
        caller = m.node_id if not owner else f"{m.node_id}#{owner}"
        for node in ast.walk(fnode):
            if not isinstance(node, ast.Call):
                continue
            chain = _py_chain(node.func)
            if not chain:
                continue
            hit = _resolve_py_call(chain, m.path, aliases, registry)
            if hit is None:
                continue
            target_id, callee = hit
            if target_id != caller:
                calls.setdefault((caller, target_id), set()).add(callee)
                callees.add(_callee_display(target_id, callee))
        if callees:
            method_calls.setdefault((m.path, key), set()).update(callees)


def _resolve_ts_spec(base_dir: str, spec: str, registry: dict[str, Any]) -> str | None:
    combined = posixpath.normpath(posixpath.join(base_dir, spec)) if base_dir else posixpath.normpath(spec)
    cands = [combined]
    if not combined.endswith(TS_EXTENSIONS):
        cands += [combined + e for e in TS_EXTENSIONS]
        cands += [combined + i for i in TS_INDEX_FILES]
    for cand in cands:
        if cand in registry:
            return cand
    return None


def _ts_target(path: str, sym: str, registry: dict[str, Any]) -> tuple[str, str] | None:
    reg = registry.get(path)
    if not reg:
        return None
    cls = reg["classes"].get(sym)
    if cls is not None:
        return cls["node"], sym
    fid = reg["funcs"].get(sym)
    if fid is not None:
        return fid, sym
    return None


def _collect_ts_calls(
    m: Module,
    aux: dict[str, Any],
    registry: dict[str, Any],
    calls: dict[tuple[str, str], set[str]],
    method_calls: dict[tuple[str, str], set[str]],
) -> None:
    imports = aux["imports"]
    spans = aux.get("spans", {})
    stripped = _strip_ts_text(m.source)

    def add(target_id: str, callee: str, position: int) -> None:
        if target_id == m.node_id:
            return
        calls.setdefault((m.node_id, target_id), set()).add(callee)
        key = None
        for name, (s, e) in spans.items():
            if s <= position < e and (key is None or s > spans[key][0]):
                key = name
        if key is not None:
            method_calls.setdefault((m.path, key), set()).add(_callee_display(target_id, callee))

    for mm in TS_CALL.finditer(stripped):
        base, sym = mm.group(1), mm.group(2)
        if base in ("this", "super"):
            continue
        imp = imports.get(base)
        if imp is None:
            continue
        spec, kind = imp
        path = _resolve_ts_spec(m.dirname, spec, registry)
        if path is None or path == m.path:
            continue
        hit = _ts_target(path, sym, registry)
        if hit is None and kind == "named":
            cls = registry.get(path, {}).get("classes", {}).get(base)
            if cls is not None and sym in cls["methods"]:
                hit = (cls["node"], sym)
        if hit is not None:
            add(*hit, mm.start())
    for mm in TS_BARE_CALL.finditer(stripped):
        name = mm.group(1)
        if name in TS_CALL_SKIP:
            continue
        imp = imports.get(name)
        if imp is None:
            continue
        spec, _kind = imp
        path = _resolve_ts_spec(m.dirname, spec, registry)
        if path is None or path == m.path:
            continue
        hit = _ts_target(path, name, registry)
        if hit is not None:
            add(*hit, mm.start())


def _build_call_registry(mods: list[Module], parsed: dict[str, Any]) -> dict[str, Any]:
    registry: dict[str, Any] = {}
    ts_langs = ("typescript", "javascript", "vue", "svelte")
    for m in sorted(mods):
        _fields, methods, _notes, aux = parsed[m.path]
        if m.lang == "python":
            classes: dict[str, Any] = {}
            funcs: dict[str, str] = {}
            for mm in methods:
                owner = mm["owner"]
                if owner:
                    classes.setdefault(owner, {"methods": set(), "node": f"{m.node_id}#{owner}"})
                    classes[owner]["methods"].add(mm["name"].split(".", 1)[1])
                else:
                    funcs[mm["name"]] = m.node_id
            registry[m.path] = {"classes": classes, "funcs": funcs}
        elif m.lang in ts_langs:
            classes = {}
            funcs = {}
            for name, kind in aux["exports"].items():
                if kind == "class":
                    classes[name] = {
                        "methods": set(aux["classes"].get(name, ())),
                        "node": f"{m.node_id}#{name}",
                    }
                else:
                    funcs[name] = m.node_id
            registry[m.path] = {"classes": classes, "funcs": funcs}
    return registry


def _call_label(names: set[str]) -> str:
    text = ", ".join(sorted(names))
    if len(text) > 40:
        text = text[:39] + "…"
    return text


# ---------------------------------------------------------------------------
# Graph assembly
# ---------------------------------------------------------------------------


def parse_module(
    m: Module,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    return PARSERS[m.lang](m.path, m.source)


def _strip_owner(method: dict[str, Any]) -> dict[str, Any]:
    """The 'owner' key is assembly-only; it must not reach the stored graph."""
    return {k: v for k, v in method.items() if k != "owner"}


def file_node(m: Module, pos: tuple[int, int], fields: list[dict], methods: list[dict], notes: dict) -> dict:
    return {
        "id": m.node_id,
        "type": "file",
        "position": {"x": pos[0], "y": pos[1]},
        "data": {
            "label": m.path.rsplit("/", 1)[-1][: -len(Path(m.path).suffix)],
            "path": m.path,
            "description": "",
            "notes": notes["module"],
            "fields": fields,
            "methods": methods,
        },
        "style": FILE_STYLE,
    }


def class_node(m: Module, cls: str, methods: list[dict], note: str, pos: tuple[int, int]) -> dict:
    return {
        "id": f"{m.node_id}#{cls}",
        "type": "class",
        "position": {"x": pos[0], "y": pos[1]},
        "data": {
            "label": cls,
            "path": m.path,
            "description": "",
            "notes": note,
            "fields": [],
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

    parsed: dict[str, tuple] = {}
    for m in sorted(mods):
        parsed[m.path] = parse_module(m)

    calls: dict[tuple[str, str], set[str]] = {}
    method_calls: dict[tuple[str, str], set[str]] = {}
    registry = _build_call_registry(mods, parsed)
    for m in sorted(mods):
        aux = parsed[m.path][3]
        if m.lang == "python":
            _collect_py_calls(m, aux, registry, calls, method_calls)
        elif m.lang in ("typescript", "javascript", "vue", "svelte"):
            _collect_ts_calls(m, aux, registry, calls, method_calls)

    def with_method_calls(path: str, mm: dict[str, Any]) -> dict[str, Any]:
        hits = method_calls.get((path, mm["name"]))
        return {**mm, "calls": sorted(hits)} if hits else mm

    def class_names(path: str) -> list[str]:
        return sorted(parsed[path][2]["classes"].keys())

    positions: dict[str, tuple[int, int]] = {}
    col = 0
    for d in container_dirs:
        positions[f"pkg:{d}"] = (col * COLUMN_W, 0)
        for j, m in enumerate(sorted(by_dir[d])):
            positions[m.node_id] = (col * COLUMN_W, FIRST_ROW + j * ROW_STEP)
            for c, cls in enumerate(class_names(m.path)):
                positions[f"{m.node_id}#{cls}"] = (
                    col * COLUMN_W,
                    2 * FIRST_ROW + j * ROW_STEP + c * 120,
                )
        col += 1
    loose = [m for d, ms in by_dir.items() if d not in container_dirs for m in ms]
    for j, m in enumerate(sorted(loose)):
        positions[m.node_id] = (col * COLUMN_W, j * ROW_STEP)
        for c, cls in enumerate(class_names(m.path)):
            positions[f"{m.node_id}#{cls}"] = (
                col * COLUMN_W,
                j * ROW_STEP + (c + 1) * 120,
            )

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
    for m in sorted(mods):
        fields, methods, notes, _aux = parsed[m.path]
        cls_methods: dict[str, list[dict[str, Any]]] = {c: [] for c in notes["classes"]}
        for mm in methods:
            if mm["owner"]:
                cls_methods.setdefault(mm["owner"], []).append(
                    with_method_calls(m.path, _strip_owner(mm))
                )
        file_methods = [with_method_calls(m.path, _strip_owner(mm)) for mm in methods if not mm["owner"]]
        nodes.append(file_node(m, positions[m.node_id], fields, file_methods, notes))
        for cls in sorted(cls_methods):
            nodes.append(
                class_node(
                    m,
                    cls,
                    cls_methods[cls],
                    notes["classes"].get(cls, ""),
                    positions[f"{m.node_id}#{cls}"],
                )
            )
    nodes.sort(key=lambda n: n["id"])

    edges: list[dict[str, Any]] = []
    for d in container_dirs:
        cid = f"pkg:{d}"
        for m in sorted(by_dir[d]):
            edges.append(_make_edge(cid, m.node_id, "contains", "", edge_ids))
            for cls in class_names(m.path):
                edges.append(_make_edge(m.node_id, f"{m.node_id}#{cls}", "contains", "", edge_ids))
    for m in sorted(mods):
        deps = _module_deps(m, modules_by_path, layer, skipped, deps_registry)
        for target in sorted(deps):
            edges.append(_make_edge(m.node_id, target, "depends-on", "in-process", edge_ids))
    for source, target in sorted(calls):
        edges.append(
            _make_edge(source, target, "calls", "", edge_ids, label=_call_label(calls[(source, target)]))
        )
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
    source: str, target: str, kind: str, protocol: str, used: set[str], label: str = ""
) -> dict[str, str]:
    base = f"e:{source}-->{target}"
    eid = base
    n = 2
    while eid in used:
        eid = f"{base}-{n}"
        n += 1
    used.add(eid)
    return {"id": eid, "source": source, "target": target, "label": label, "kind": kind, "protocol": protocol}


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
