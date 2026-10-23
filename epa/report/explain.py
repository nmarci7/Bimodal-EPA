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


def _tok(m, k, fields):
    parts = [f"{f} {k['b'][f]}" for f in fields if k["b"].get(f)]
    if k.get("t"):
        parts.append("tainted")
    if k.get("c"):
        parts.append(m.conf_levels[k["c"]])
    if k.get("a", m.auth_top) < m.auth_top:
        parts.append(f"authority {m.auth_levels[k['a']]}")
    return ", ".join(parts) or "clean"


def trace_story(m, trace, fields):
    """Round by round, the edges whose label changed, with the rows that fired."""
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
            head = "start" if prev is None else f"round {st['round']}"
            lines.append({"step": head, "edges": what, "fired": st.get("fired", [])})
        prev = st
    return lines
