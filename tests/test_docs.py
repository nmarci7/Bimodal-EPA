"""The documentation keeps up with the code: every module, class and function of epa/ and web/ is named
in the developer reference (docs/dev/), the generated call graph is current, and every link and image
in docs/ exists."""
import glob
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import inventory  # noqa: E402


def reference_text():
    pages = [p for p in glob.glob(os.path.join(ROOT, "docs", "dev", "*.md")) if not p.endswith("call-graph.md")]
    text = "\n".join(open(p, encoding="utf-8").read() for p in pages)
    text = re.sub(r"```.*?```", "", text, flags=re.S)          # diagrams and examples
    return "\n".join(re.findall(r"`([^`\n]+)`", text))          # the names, as inline code


def test_every_definition_is_documented():
    names = reference_text()
    found = lambda n: re.search(r"(?<![\w])" + re.escape(n) + r"(?![\w])", names) is not None  # noqa: E731
    missing = []
    for path, m in {**inventory.py_inventory(), **inventory.js_inventory()}.items():
        for item in m["items"]:
            if not found(item["name"]):
                missing.append(f"{path}: {item['name']}")
            for x in item.get("methods", []):
                if x["name"] != "constructor" and not found(x["name"]):
                    missing.append(f"{path}: {item['name']}.{x['name']}")
    assert not missing, "not described in docs/dev/*.md: " + ", ".join(missing)


def test_call_graph_is_current():
    now = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "inventory.py"), "--md"], capture_output=True, text=True, check=True).stdout
    with open(os.path.join(ROOT, "docs", "dev", "call-graph.md"), encoding="utf-8") as f:
        assert f.read() == now, "docs/dev/call-graph.md is out of date: python tools/inventory.py --md > docs/dev/call-graph.md"


def test_links_and_images_exist():
    broken = []
    for page in glob.glob(os.path.join(ROOT, "docs", "**", "*.md"), recursive=True) + [os.path.join(ROOT, "README.md")]:
        text = re.sub(r"```.*?```", "", open(page, encoding="utf-8").read(), flags=re.S)
        for target in re.findall(r"\]\(([^)\s#]+)(?:#[^)]*)?\)", text):
            if "://" in target:
                continue
            if not os.path.exists(os.path.normpath(os.path.join(os.path.dirname(page), target))):
                broken.append(f"{os.path.relpath(page, ROOT)} → {target}")
    assert not broken, "broken links: " + ", ".join(broken)
