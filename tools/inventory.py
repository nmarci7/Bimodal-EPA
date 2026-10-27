#!/usr/bin/env python3
"""The code inventory behind docs/developer-guide.md: every module, class and function of the engine
(epa/) and the reasoner (web/), and who calls whom.

    python tools/inventory.py            a summary per file (functions, line numbers, first docstring line)
    python tools/inventory.py --json     everything as JSON (used by tests/test_docs.py)
    python tools/inventory.py --calls    the project-internal call graph of epa/, as "caller -> callee"
    python tools/inventory.py --md       docs/dev/call-graph.md: who calls whom, per module, and the module graph

Python is read with ast (exact). JavaScript is read with regular expressions over the plain ES modules
in web/ (function declarations, classes and their methods, imports), which is enough for this code.
"""
import ast
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------- Python
def py_files():
    out = []
    for base, _, names in os.walk(os.path.join(ROOT, "epa")):
        for n in sorted(names):
            if n.endswith(".py"):
                out.append(os.path.relpath(os.path.join(base, n), ROOT))
    return sorted(out)


def module_name(path):
    mod = path[:-3].replace(os.sep, ".")
    return mod[:-9] if mod.endswith(".__init__") else mod


def first_line(doc):
    return (doc or "").strip().split("\n")[0].strip()


def py_inventory():
    mods = {}
    for path in py_files():
        src = open(os.path.join(ROOT, path), encoding="utf-8").read()
        tree = ast.parse(src)
        items = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                items.append({"kind": "function", "name": node.name, "line": node.lineno,
                              "args": [a.arg for a in node.args.args], "doc": first_line(ast.get_docstring(node))})
            elif isinstance(node, ast.ClassDef):
                methods = [{"name": m.name, "line": m.lineno, "args": [a.arg for a in m.args.args],
                            "doc": first_line(ast.get_docstring(m))}
                           for m in node.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))]
                items.append({"kind": "class", "name": node.name, "line": node.lineno,
                              "doc": first_line(ast.get_docstring(node)), "methods": methods})
        mods[path] = {"module": module_name(path), "doc": first_line(ast.get_docstring(tree)),
                      "lines": src.count("\n") + 1, "items": items}
    return mods


def py_calls(mods):
    """Calls between functions of the project, resolved through each module's imports."""
    defined = {}                                # module -> {name}
    for path, m in mods.items():
        defined[m["module"]] = {i["name"] for i in m["items"]}
    edges = set()
    for path, m in mods.items():
        tree = ast.parse(open(os.path.join(ROOT, path), encoding="utf-8").read())
        here = m["module"]
        pkg = here.rsplit(".", 1)[0]
        alias = {}                              # local name -> (module, name or None)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    parts = (here if path.endswith("__init__.py") else pkg).split(".")
                    parts = parts[: len(parts) - (node.level - 1)] if node.level > 1 else parts
                    base = ".".join(parts + ([node.module] if node.module else []))
                for a in node.names:
                    full = f"{base}.{a.name}"
                    if full in defined:          # a module imported by name: from . import cone as C
                        alias[a.asname or a.name] = (full, None)
                    elif base in defined:
                        alias[a.asname or a.name] = (base, a.name)
            elif isinstance(node, ast.Import):
                for a in node.names:
                    if a.name in defined:
                        alias[a.asname or a.name] = (a.name, None)

        def visit(func, owner):
            caller = f"{here}.{owner + '.' if owner else ''}{func.name}"
            for n in ast.walk(func):
                if not isinstance(n, ast.Call):
                    continue
                f = n.func
                if isinstance(f, ast.Name):
                    if f.id in defined[here]:
                        edges.add((caller, f"{here}.{f.id}"))
                    elif f.id in alias and alias[f.id][1]:
                        edges.add((caller, f"{alias[f.id][0]}.{alias[f.id][1]}"))
                elif isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
                    base = f.value.id
                    if base in alias and alias[base][1] is None and f.attr in defined.get(alias[base][0], set()):
                        edges.add((caller, f"{alias[base][0]}.{f.attr}"))
                    elif base == "self" and owner:
                        edges.add((caller, f"{here}.{owner}.{f.attr}"))
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                visit(node, None)
            elif isinstance(node, ast.ClassDef):
                for mth in node.body:
                    if isinstance(mth, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        visit(mth, node.name)
    known = {f"{m['module']}.{i['name']}" for m in mods.values() for i in m["items"]} | \
            {f"{m['module']}.{i['name']}.{x['name']}" for m in mods.values() for i in m["items"] if i["kind"] == "class" for x in i["methods"]}
    return sorted((a, b) for a, b in edges if b in known and a != b)


# ---------------------------------------------------------------- JavaScript
FUNC = re.compile(r"^(export\s+)?(async\s+)?function\s+(\w+)\s*\(", re.M)
CLASS = re.compile(r"^(export\s+)?class\s+(\w+)", re.M)
METHOD = re.compile(r"^  (async\s+)?(\w+)\s*\([^)]*\)\s*\{", re.M)
CONSTFN = re.compile(r"^export\s+const\s+(\w+)\s*=\s*(\(|async|\w+\s*=>)", re.M)
IMPORT = re.compile(r"^import\s+\{([^}]*)\}\s+from\s+'\./(\w+)\.js'", re.M)
KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "function"}


def js_inventory():
    mods = {}
    web = os.path.join(ROOT, "web")
    for n in sorted(os.listdir(web)):
        if not n.endswith(".js"):
            continue
        src = open(os.path.join(web, n), encoding="utf-8").read()
        line = lambda pos: src.count("\n", 0, pos) + 1  # noqa: E731
        head = []
        for ln in src.splitlines():
            if not ln.startswith("//"):
                break
            head.append(ln[2:].strip())
        items = []
        classes = [(m.start(), m.group(2), bool(m.group(1))) for m in CLASS.finditer(src)]
        for pos, name, exported in classes:
            end = src.find("\n}\n", pos)
            body = src[pos:end if end > 0 else len(src)]
            meths = [{"name": m.group(2), "line": line(pos + m.start())} for m in METHOD.finditer(body) if m.group(2) not in KEYWORDS]
            items.append({"kind": "class", "name": name, "line": line(pos), "exported": exported, "methods": meths})
        for m in FUNC.finditer(src):
            items.append({"kind": "function", "name": m.group(3), "line": line(m.start()), "exported": bool(m.group(1))})
        for m in CONSTFN.finditer(src):
            items.append({"kind": "function", "name": m.group(1), "line": line(m.start()), "exported": True})
        imports = {mod: [x.strip().split(" as ")[0] for x in names.split(",") if x.strip()] for names, mod in IMPORT.findall(src)}
        items.sort(key=lambda x: x["line"])
        mods[f"web/{n}"] = {"doc": " ".join(head), "lines": src.count("\n") + 1, "items": items, "imports": imports}
    return mods


def py_imports(mods):
    """Module-level dependencies inside epa/: {module: {modules it imports from}}."""
    names = {m["module"] for m in mods.values()}
    out = {}
    for path, m in mods.items():
        tree = ast.parse(open(os.path.join(ROOT, path), encoding="utf-8").read())
        here = m["module"]
        pkg = here if path.endswith("__init__.py") else here.rsplit(".", 1)[0]
        deps = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                if node.level:
                    parts = pkg.split(".")
                    parts = parts[: len(parts) - (node.level - 1)] if node.level > 1 else parts
                    base = ".".join(parts + ([node.module] if node.module else []))
                else:
                    base = node.module or ""
                for a in node.names:
                    full = f"{base}.{a.name}"
                    deps.add(full if full in names else base)
            elif isinstance(node, ast.Import):
                deps.update(a.name for a in node.names)
        out[here] = sorted(d for d in deps if d in names and d != here)
    return out


def markdown(py, js):
    calls = py_calls(py)
    lines = ["# Call graph", "",
             "Generated by `python tools/inventory.py --md` from the code (Python by `ast`; calls are resolved through",
             "each module's imports, so calls through objects other than `self` and dynamic calls are not listed).",
             "Regenerate it after changing the code; `tests/test_docs.py` checks it is current.", "",
             "## Module dependencies (epa/)", "", "```mermaid", "flowchart LR"]
    ids = {}
    for mod, deps in sorted(py_imports(py).items()):
        if mod in ("epa", "epa.__main__"):
            continue
        for d in deps:
            if d in ("epa",):
                continue
            a = ids.setdefault(mod, f"m{len(ids)}")
            b = ids.setdefault(d, f"m{len(ids)}")
            lines.append(f"  {a}[{mod.replace('epa.', '')}] --> {b}[{d.replace('epa.', '')}]")
    lines += ["```", "", "## Who calls whom (epa/)", "", "| caller | calls |", "|---|---|"]
    by = {}
    for a, b in calls:
        by.setdefault(a, []).append(b)
    for a in sorted(by):
        lines.append(f"| `{a.replace('epa.', '')}` | {', '.join(f'`{x.replace(chr(101) + chr(112) + chr(97) + chr(46), '')}`' for x in sorted(by[a]))} |")
    lines += ["", "## Imports between the browser modules (web/)", "", "```mermaid", "flowchart LR"]
    for path, m in sorted(js.items()):
        a = path.split("/")[-1][:-3]
        for mod in sorted(m["imports"]):
            lines.append(f"  {a} --> {mod}")
    lines += ["```", ""]
    return "\n".join(lines)


def main():
    py, js = py_inventory(), js_inventory()
    if "--md" in sys.argv:
        print(markdown(py, js))
        return
    if "--json" in sys.argv:
        print(json.dumps({"python": py, "js": js, "calls": py_calls(py)}, indent=1))
        return
    if "--calls" in sys.argv:
        for a, b in py_calls(py):
            print(f"{a} -> {b}")
        return
    for path, m in {**py, **js}.items():
        print(f"\n{path} ({m['lines']} lines): {m['doc'][:100]}")
        for i in m["items"]:
            print(f"  {i['line']:>4} {i['kind']} {i['name']}" + (f" — {i.get('doc', '')[:90]}" if i.get("doc") else ""))
            for x in i.get("methods", []):
                print(f"  {x['line']:>4}   .{x['name']}" + (f" — {x.get('doc', '')[:80]}" if x.get("doc") else ""))


if __name__ == "__main__":
    main()
