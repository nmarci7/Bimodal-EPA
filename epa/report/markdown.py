"""The analysis as a Markdown report (verdicts, evidence, conflicts, root causes, ranking) and the
regulator-facing export under neutral labels."""
from __future__ import annotations

import datetime

from .explain import NEUTRAL, reason_line


def report(rep):
    m = rep["model"]
    L = [f"# Verdicts for {m['name']}", "",
         f"_Generated {datetime.datetime.now():%Y-%m-%d %H:%M} by the EPA engine v2 "
         f"(TLC {rep['engine'].get('tlc') or '-'}, clingo {rep['engine']['clingo']})._", ""]
    by_obs = {}
    for c in rep["cells"]:
        by_obs.setdefault(c["obs"], []).append(c)
    for obs, cells in by_obs.items():
        o = m["obs"][obs]
        L.append(f"## {o['label'] or obs} (`{obs}`)")
        L.append("")
        for c in cells:
            st = ",".join(c["statuses"])
            line = f"- **{c['field']}**: {c['verdict']}" + (f" {{{st}}}" if st else "")
            rc = c["candidates"]
            if rc.get("remaining") is not None:
                line += f" — {rc['remaining']} of {rc['space']} candidates remain"
            why = reason_line(c)
            if why:
                line += f" — {why}"
            if c.get("advice"):
                line += f". _{c['advice']}._"
            L.append(line)
            if c.get("root_causes") and c["verdict"] != "guarantee":
                L.append("  - root causes: " + "; ".join("{" + ", ".join(s) + "}" for s in c["root_causes"]))
        L.append("")
    reg = rep["register"]
    L.append("## Evidence register")
    L.append("")
    for k in reg["certificates"]:
        L.append(f"- certificate `{k['id']}` on {k.get('component')} ({k.get('version')}, {k.get('method', '')}, "
                 f"{k.get('issuer', '')}, {k.get('date', '')}): **{k['state']}**" + (f" — {k['reason']}" if k["reason"] else ""))
    for w in reg["witnesses"]:
        L.append(f"- witness `{w['id']}` from {w.get('source', '')} ({w.get('recogniser', '')}, {w.get('date', '')}): "
                 f"**{w['state']}**" + (f" — {w['reason']}" if w["reason"] else ""))
    L.append("")
    if rep.get("ranking"):
        L.append("## Certify next")
        L.append("")
        for a in rep["ranking"][:10]:
            moved = ", ".join(x["cell"] for x in a["moved"])
            L.append(f"- {' + '.join(a['action'])}: key {a['key']}" + (f" — moves {moved}" if moved else "")
                     + (f" — {a['note']}" if a["note"] else ""))
        L.append("")
    if rep.get("reverify"):
        L.append("## Re-verify")
        L.append("")
        for r in rep["reverify"]:
            ch = "; ".join(f"{x['component']} {x['signed_with']} → {x['now']}" for x in r["changes"])
            L.append(f"- `{r['certificate']}`: {ch}")
        L.append("")
    if rep.get("unmatched"):
        L.append("## Unmatched failures (absorbed silently: check the tables)")
        L.append("")
        for u in rep["unmatched"]:
            L.append(f"- {u['mode']} at {u['component']}.{u['port']}")
        L.append("")
    return "\n".join(L)


def cra_export(rep, product="", version=""):
    """Every cell under a neutral label with the evidence it rests on, and what the tool does not provide."""
    out = {"product": product or rep["model"]["name"], "version": version,
           "generated": datetime.datetime.now().isoformat(timespec="seconds"),
           "method": "bimodal error propagation analysis (alethic: TLA+/TLC runs; epistemic: ASP over candidates)",
           "mapping": {"risk assessment": "CRA Art. 13(2)-(4)", "technical documentation": "Art. 31, Annex VII",
                       "vulnerability handling": "Annex I Part II", "severe incident": "Art. 14(4)"},
           "cells": [], "not_provided": [
               "probabilities or rates of failure", "conformity with harmonised standards",
               "behaviour outside the modelled use cases and edges", "correctness of the mapping tables themselves"]}
    for c in rep["cells"]:
        out["cells"].append({"observation_point": c["obs"], "failure": c["field"],
                             "assessment": NEUTRAL.get(c["verdict"], c["verdict"]),
                             "statuses": c["statuses"], "basis": reason_line(c),
                             "attestations": c["reasons"].get("certificates", []),
                             "observation_records": c.get("witnesses_used", [])})
    return out
