"""The shared workspace: one model and its evidence in a JSON file that the MCP server edits and the
reasoner can open or save into (File → Open / Save the shared workspace). The file lives in the
work folder (EPA_WORK, default .epa-work/) next to the run cache, so the browser's server and the MCP
server, two processes, see the same one.

    {"version": 1, "updated": <unix time>, "by": "mcp" | "browser",
     "doc": <model document>, "evidence": {certificates, witnesses, decisions, recognisers,
     deployments, lookups}, "case": <demo case id or null>, "stage": <stage id or null>,
     "report": <the last analysis report or null>}

Writes go through a temporary file and a rename, so a reader never sees half a file.
"""
from __future__ import annotations

import json
import os
import tempfile
import time

VERSION = 1


def default_path(work=None):
    work = work or os.environ.get("EPA_WORK") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".epa-work")
    return os.path.join(work, "workspace.json")


def empty_evidence():
    return {"certificates": [], "witnesses": [], "decisions": [], "recognisers": {}, "deployments": None, "lookups": {}, "files": []}


def blank():
    return {"version": VERSION, "updated": None, "by": None, "doc": None, "evidence": empty_evidence(),
            "case": None, "stage": None, "report": None}


def load(path):
    """The workspace at path, or a blank one if there is none yet."""
    if not os.path.exists(path):
        return blank()
    with open(path, encoding="utf-8") as f:
        ws = json.load(f)
    out = blank()
    out.update({k: v for k, v in ws.items() if k in out})
    out["evidence"] = {**empty_evidence(), **(ws.get("evidence") or {})}
    return out


def save(path, ws, by):
    """Write the workspace atomically; returns the time stamp written."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    ws = {**blank(), **ws, "version": VERSION, "updated": time.time(), "by": by}
    fd, tmp = tempfile.mkstemp(prefix=".workspace-", suffix=".json", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(ws, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return ws["updated"]


def meta(path):
    """When the workspace was last written, and by whom, without reading the whole file into a reply."""
    if not os.path.exists(path):
        return {"exists": False, "updated": None, "by": None, "name": None}
    ws = load(path)
    return {"exists": True, "updated": ws["updated"], "by": ws["by"], "name": (ws["doc"] or {}).get("name"),
            "case": ws["case"], "stage": ws["stage"]}
