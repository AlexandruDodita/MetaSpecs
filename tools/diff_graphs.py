"""Diff two MetaSpecs graph files and report architectural drift.

Accepts importer output, a project file, or a bare layer graph. Matches nodes
by id, then by non-empty data.path; edges match by mapped (source, target).
Reports added/removed/changed nodes and edges per layer. Exit: 0 no drift,
1 drift found, 2 usage/input error.
"""

import argparse
import json
import sys

LAYERS = ("backend", "db", "frontend")

CATS = (
    ("nodes_added", "node added"),
    ("nodes_removed", "node removed"),
    ("nodes_changed", "node changed"),
    ("reconciled_by_path", "reconciled by path"),
    ("edges_added", "edge added"),
    ("edges_removed", "edge removed"),
    ("edges_changed", "edge changed"),
)
CAT_KEYS = [c[0] for c in CATS]

LAYOUT_FIELDS = ("position", "style", "measured")


def error_exit(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(2)


def node_path(node):
    data = node.get("data") or {}
    p = data.get("path")
    return p if isinstance(p, str) and p else ""


def load_graph_file(path, layer_override):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        error_exit(f"{path}: no such file")
    except json.JSONDecodeError as exc:
        error_exit(f"{path}: invalid JSON ({exc})")
    if not isinstance(data, dict):
        error_exit(f"{path}: not a MetaSpecs graph file (expected a JSON object)")
    if isinstance(data.get("graphs"), dict):
        graphs = data["graphs"]
    elif isinstance(data.get("nodes"), list) or isinstance(data.get("edges"), list):
        graphs = {layer_override or "backend": data}
    else:
        error_exit(f"{path}: not a MetaSpecs graph file (no 'graphs' or 'nodes'/'edges' key)")
    layers = {}
    for name, graph in graphs.items():
        if not isinstance(graph, dict):
            continue
        nodes = graph.get("nodes") if isinstance(graph.get("nodes"), list) else []
        edges = graph.get("edges") if isinstance(graph.get("edges"), list) else []
        layers[name] = {"nodes": nodes, "edges": edges}
    return layers


def match_nodes(old_nodes, new_nodes):
    new_by_id = {n["id"]: n for n in new_nodes}
    pairs = []
    used_new = set()
    for n in old_nodes:
        nid = n["id"]
        if nid in new_by_id and nid not in used_new:
            pairs.append((n, new_by_id[nid], "id"))
            used_new.add(nid)
    new_by_path = {}
    for n in new_nodes:
        if n["id"] not in used_new:
            p = node_path(n)
            if p:
                new_by_path.setdefault(p, n)
    for n in old_nodes:
        if n["id"] in used_new:
            continue
        p = node_path(n)
        if p and p in new_by_path:
            new_node = new_by_path.pop(p)
            pairs.append((n, new_node, "path"))
            used_new.add(new_node["id"])
    matched_old = {n["id"] for n, _, _ in pairs}
    added = [n for n in new_nodes if n["id"] not in used_new]
    removed = [n for n in old_nodes if n["id"] not in matched_old]
    return pairs, added, removed


def match_edges(old_edges, new_edges, id_map):
    new_by_key = {}
    for ne in new_edges:
        new_by_key.setdefault((ne.get("source"), ne.get("target")), []).append(ne)
    matched = []
    used_new = set()
    for oi, oe in enumerate(old_edges):
        s = id_map.get(oe.get("source"))
        t = id_map.get(oe.get("target"))
        if s is None or t is None:
            continue
        keys = [(s, t)]
        if oe.get("kind") == "contains":
            keys.append((t, s))
        for key in keys:
            pool = [ne for ne in new_by_key.get(key, ()) if id(ne) not in used_new]
            if pool:
                matched.append((oi, oe, pool[0]))
                used_new.add(id(pool[0]))
                break
    matched_idx = {oi for oi, _, _ in matched}
    added = [ne for ne in new_edges if id(ne) not in used_new]
    removed = [oe for oi, oe in enumerate(old_edges) if oi not in matched_idx]
    return matched, added, removed


def diff_members(old_list, new_list):
    old_by_name = {m.get("name"): m for m in old_list if isinstance(m, dict)}
    new_by_name = {m.get("name"): m for m in new_list if isinstance(m, dict)}
    added = sorted(n for n in new_by_name if n not in old_by_name)
    removed = sorted(n for n in old_by_name if n not in new_by_name)
    changed = []
    for name in sorted(set(old_by_name) & set(new_by_name)):
        d = {}
        om, nm = old_by_name[name], new_by_name[name]
        for key in set(om) | set(nm):
            if key in ("name", "id"):
                continue
            ov, nv = om.get(key, ""), nm.get(key, "")
            if ov != nv:
                d[key] = {"old": ov, "new": nv}
        if d:
            changed.append({"name": name, "diff": d})
    return added, removed, changed


def compare_node(old_node, new_node, include_layout):
    o_data = old_node.get("data") or {}
    n_data = new_node.get("data") or {}
    diff = {}
    if old_node.get("type") != new_node.get("type"):
        diff["type"] = {"old": old_node.get("type"), "new": new_node.get("type")}
    for key in ("label", "path", "description"):
        ov, nv = o_data.get(key, ""), n_data.get(key, "")
        if ov != nv:
            diff[key] = {"old": ov, "new": nv}
    # Either side, so a node retyped to/from class still reports its members.
    if "class" in (old_node.get("type"), new_node.get("type")):
        for mkey in ("fields", "methods"):
            o_list = o_data.get(mkey) or []
            n_list = n_data.get(mkey) or []
            added, removed, changed = diff_members(o_list, n_list)
            if added or removed or changed:
                diff[mkey] = {"added": added, "removed": removed, "changed": changed}
    if include_layout:
        for key in LAYOUT_FIELDS:
            if old_node.get(key) != new_node.get(key):
                diff[key] = {"old": old_node.get(key), "new": new_node.get(key)}
    return diff


def compare_edge(old_edge, new_edge):
    diff = {}
    for key in ("kind", "protocol", "label"):
        ov, nv = old_edge.get(key, ""), new_edge.get(key, "")
        if ov != nv:
            diff[key] = {"old": ov, "new": nv}
    return diff


def node_meta(node):
    return {"id": node["id"], "label": (node.get("data") or {}).get("label", ""),
            "path": node_path(node)}


def edge_meta(edge):
    return {"source": edge.get("source"), "target": edge.get("target"),
            "kind": edge.get("kind", ""), "protocol": edge.get("protocol", ""),
            "label": edge.get("label", "")}


def diff_layer(old_g, new_g, include_layout):
    pairs, added_nodes, removed_nodes = match_nodes(old_g["nodes"], new_g["nodes"])
    id_map = {o["id"]: n["id"] for o, n, _ in pairs}

    nodes_changed = []
    reconciled = []
    for o, n, how in pairs:
        meta = node_meta(n)
        diff = compare_node(o, n, include_layout)
        if how == "path":
            entry = {"old_id": o["id"], "new_id": n["id"], **meta}
            if diff:
                entry["diff"] = diff
            reconciled.append(entry)
        elif diff:
            nodes_changed.append({**meta, "diff": diff})

    matched_edges, added_edges, removed_edges = match_edges(
        old_g["edges"], new_g["edges"], id_map)
    edges_changed = []
    for _, oe, ne in matched_edges:
        diff = compare_edge(oe, ne)
        if diff:
            edges_changed.append({"source": ne.get("source"), "target": ne.get("target"),
                                  "diff": diff})

    return {
        "nodes_added": [node_meta(n) for n in added_nodes],
        "nodes_removed": [node_meta(n) for n in removed_nodes],
        "nodes_changed": nodes_changed,
        "reconciled_by_path": reconciled,
        "edges_added": [edge_meta(e) for e in added_edges],
        "edges_removed": [edge_meta(e) for e in removed_edges],
        "edges_changed": edges_changed,
    }


def build_report(layers_old, layers_new, names, include_layout):
    totals = {key: 0 for key in CAT_KEYS}
    layers = {}
    for name in names:
        old_g = layers_old.get(name, {"nodes": [], "edges": []})
        new_g = layers_new.get(name, {"nodes": [], "edges": []})
        lr = diff_layer(old_g, new_g, include_layout)
        layers[name] = lr
        for key in CAT_KEYS:
            totals[key] += len(lr[key])
    totals["total"] = sum(totals[k] for k in CAT_KEYS)
    return {"drift": totals["total"] > 0, "layers": layers, "totals": totals}


def pluralize(base, n):
    if n == 1 or base.startswith("reconciled"):
        return base
    first, _, rest = base.partition(" ")
    if first.endswith("y"):
        first = first[:-1] + "ies"
    else:
        first += "s"
    return " ".join(x for x in (first, rest) if x)


def fmt_num(v):
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def fmt_value(v):
    if isinstance(v, dict) and set(v) == {"x", "y"} and all(
            isinstance(v[k], (int, float)) for k in ("x", "y")):
        return f"({fmt_num(v['x'])}, {fmt_num(v['y'])})"
    if isinstance(v, str):
        return v if v else '""'
    return json.dumps(v, ensure_ascii=False)


def node_line(n):
    label = str(n.get("label") or "")
    path = str(n.get("path") or "")
    nid = str(n.get("id") or "")
    s = label or path or nid
    if path and path != s:
        s += f" ({path})"
    if nid and nid not in (s, path):
        s += f" [{nid}]"
    return s


def diff_lines(diff):
    out = []
    for key in ("type", "label", "path", "description") + LAYOUT_FIELDS:
        if key in diff:
            d = diff[key]
            out.append(f"{key}: {fmt_value(d['old'])} → {fmt_value(d['new'])}")
    for mkey, word in (("fields", "field"), ("methods", "method")):
        if mkey in diff:
            md = diff[mkey]
            for name in md.get("added", []):
                out.append(f"{word} {name} added")
            for name in md.get("removed", []):
                out.append(f"{word} {name} removed")
            for ch in md.get("changed", []):
                for fk, fv in ch["diff"].items():
                    out.append(f"{word} {ch['name']}: {fk} {fmt_value(fv['old'])} → {fmt_value(fv['new'])}")
    return out


def edge_line(e):
    s = f"{e.get('source')} → {e.get('target')}"
    meta = []
    if e.get("kind"):
        meta.append(f"kind={e['kind']}")
    if e.get("protocol"):
        meta.append(f"protocol={e['protocol']}")
    if e.get("label"):
        meta.append(f'label="{e["label"]}"')
    if meta:
        s += " (" + ", ".join(meta) + ")"
    return s


def render_item(key, item):
    if key in ("nodes_added", "nodes_removed"):
        return [node_line(item)]
    if key == "nodes_changed":
        return [node_line(item)] + diff_lines(item.get("diff") or {})
    if key == "reconciled_by_path":
        head = f"{item.get('old_id')} → {item.get('new_id')}"
        if item.get("path"):
            head += f" ({item['path']})"
        return [head] + diff_lines(item.get("diff") or {})
    if key in ("edges_added", "edges_removed"):
        return [edge_line(item)]
    if key == "edges_changed":
        parts = [f"{item.get('source')} → {item.get('target')}"]
        for fk, fv in item["diff"].items():
            parts.append(f"{fk} {fmt_value(fv['old'])} → {fmt_value(fv['new'])}")
        return [": ".join(parts)]
    return []


def render_text(report):
    blocks = []
    for layer, lr in report["layers"].items():
        lines = [layer]
        for key, base in CATS:
            items = lr[key]
            if not items:
                continue
            lines.append(f"  {pluralize(base, 2)}")
            for item in items:
                for sub in render_item(key, item):
                    lines.append(f"    {sub}")
        bits = [f"{len(lr[key])} {pluralize(base, len(lr[key]))}"
                for key, base in CATS if lr[key]]
        lines.append("  " + ", ".join(bits) if bits else "  no differences")
        blocks.append("\n".join(lines))
    total = report["totals"]["total"]
    blocks.append("no drift" if total == 0
                  else f"{total} {pluralize('difference', total)}")
    return "\n\n".join(blocks) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="diff_graphs.py",
        description="Compare two MetaSpecs graph files and report architectural drift.")
    parser.add_argument("old", metavar="OLD.json")
    parser.add_argument("new", metavar="NEW.json")
    parser.add_argument("--layer", choices=LAYERS,
                        help="restrict comparison to one layer")
    parser.add_argument("--json", action="store_true",
                        help="emit a machine-readable report on stdout")
    parser.add_argument("--include-layout", action="store_true",
                        help="also report position/style/measured changes")
    args = parser.parse_args(argv)

    layers_old = load_graph_file(args.old, args.layer)
    layers_new = load_graph_file(args.new, args.layer)

    names = sorted((set(layers_old) | set(layers_new)) if not args.layer
                   else {args.layer})

    report = build_report(layers_old, layers_new, names, args.include_layout)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        sys.stdout.write(render_text(report))
    return 1 if report["drift"] else 0


if __name__ == "__main__":
    sys.exit(main())
