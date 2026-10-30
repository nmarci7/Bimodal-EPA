"""Human-readable lines: why a verdict holds, and a reaching run told as a story."""
from __future__ import annotations

NEUTRAL = {  # the regulator-facing labels of the CRA export
    "guarantee": "ruled out (model-relative)",
    "hope": "possible, mitigated, monitored",
    "exposed": "occurs whenever exercised",
    "unchecked": "undetermined",
    "not exercised": "not exercised by the modelled use cases",
    "conflict": "evidence in conflict",
}


TAINT_WORDS = ("clean", "internal", "external, identified", "external, open")


def reason_line(cell):
    r = cell.get("reasons") or {}
    parts = []
    if r.get("structural"):
        parts.append("structural: no row can change it")
    if r.get("certificates"):
        parts.append("rests on " + ", ".join(r["certificates"]))
    for d in r.get("decisions", []):
        parts.append(f"default dropped on {d['component']} ({d['port']}/{d['mode']}): \"{d['reason']}\"")
    if cell.get("suspended"):
        parts.append("suspended: " + ", ".join(cell["suspended"]))
    return "; ".join(parts)


def fidelity_line(cell):
    """Consistent, complete, correct in words, with what stands in the way."""
    f = cell.get("fidelity")
    if not f:
        return ""
    parts = [("consistent" if f["consistent"] else "not consistent"),
             ("complete" if f["complete"] else "not complete"), ("correct" if f["correct"] else "not correct")]
    gaps = [f"{u['component']}: " + ", ".join(f"{', '.join(fs)} on {p}" for p, fs in u["heads"].items())
            for u in f["uncovered"]]
    line = ", ".join(parts)
    if gaps:
        line += "; uncovered " + "; ".join(gaps)
    if f["unconfirmed"]:
        line += "; no confirmed table on " + ", ".join(f["unconfirmed"])
    return line


def _tok(m, k, fields):
    parts = [f"{f} {k['b'][f]}" for f in fields if k["b"].get(f)]
    if k.get("t"):
        parts.append(f"taint {TAINT_WORDS[k['t']]}")
    if k.get("c"):
        parts.append(m.conf_levels[k["c"]])
    if k.get("a", m.auth_top) < m.auth_top:
        parts.append(f"authority {m.auth_levels[k['a']]}")
    return ", ".join(parts) or "clean"


def trace_story(m, trace, fields):
    """Step by step (firings, or rounds), the edges whose label changed, with the rows that applied."""
    if not trace:
        return []
    lines, prev = [], None
    for st in trace["steps"]:
        changed = []
        for eid, lab in st["labels"].items():
            if prev is None:
                if lab["u"]:
                    changed.append((eid, lab))
            elif lab != prev["labels"].get(eid):
                changed.append((eid, lab))
        if changed:
            what = []
            for eid, lab in changed:
                e = m.edges[eid]
                src = e.src[1] if e.src[0] == "sys" else e.src[0]
                dst = e.dst[1] if e.dst[0] == "sys" else e.dst[0]
                what.append(f"{src} → {dst}: {_tok(m, lab['k'], fields)}")
            comp = st.get("component")
            head = "start" if prev is None else (f"firing {st['round']}: {comp}" if comp else f"round {st['round']}")
            lines.append({"step": head, "edges": what, "fired": st.get("fired", [])})
        prev = st
    return lines
