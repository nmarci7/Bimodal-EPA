"""Generated rows: the LLM worst-case table and the rows every guard carries."""


def replaces_default(comp, r, port, mode):
    """An analyst row refines the default (port, mode) in place only if it keeps the default's trigger -
    any input, any message - and emits that same top-level mode there. Any narrower row (a failure
    pattern, a fork-join, one port of several) would say that the LLM does not start the failure on
    its own, which only a recorded structural reason may say; such a row goes beside the default."""
    if r.kind != "row" or mode not in r.then.get(port, {}):
        return False
    w = r.when
    if w == {"*": {"any": True}}:
        return True
    return len(comp.ins) == 1 and w == {comp.ins[0]: {"any": True}}


def add_llm_defaults(m):
    """Every LLM component starts with a worst-case table: for each output port and each top-level
    mode, `any message => mode const 10`. An analyst row with the same trigger that emits the same
    mode on the same port replaces it (a magnitude below 10 is recorded as a calibration); every other
    analyst row is added beside it; a default may be dropped only with a recorded reason."""
    from .load import Row
    for cdoc in m.doc["components"]:
        if cdoc["kind"] != "llm":
            continue
        cid = cdoc["id"]
        comp = m.components[cid]
        dropped = {(d["port"], d["mode"]): d["reason"] for d in cdoc.get("drop_defaults", [])}
        for port in comp.outs:
            covered = {}
            for r in m.comp_rows(cid):
                for mode in m.top_modes:
                    if replaces_default(comp, r, port, mode):
                        covered.setdefault(mode, r)
            for mode, r in covered.items():
                op, k = r.then[port][mode]
                if op == "const" and k < 10:
                    m.decisions.append({"kind": "calibrate-default", "component": cid, "port": port, "mode": mode,
                                        "row": r.id, "from": 10, "to": k,
                                        "reason": r.reason or r.label or "calibrated by the analyst"})
            for mode in m.top_modes:
                if mode in covered:
                    continue
                if (port, mode) in dropped:
                    m.decisions.append({"kind": "drop-default", "component": cid, "port": port, "mode": mode,
                                        "reason": dropped[(port, mode)]})
                    continue
                rid = f"default.{cid}.{port}.{mode}"
                m.rows[rid] = Row(id=rid, comp=cid, kind="default", when={"*": {"any": True}},
                                  then={port: {mode: ("const", 10)}}, open=True, llm=True,
                                  label=f"worst-case default: {mode} on {port}")


def add_guard_rows(m):
    """One leak row per target (the target gets through); a false-positive row (an omission)
    for every learned guard. A leak row may be certified never only if its target is decidable
    from the data on the edge and the guard is not learned."""
    from .load import Row
    for g in m.components.values():
        if not g.is_guard:
            continue
        for t in g.targets:
            key = t["mode"] if t["kind"] == "mode" else t["kind"]
            rid = f"leak.{g.id}.{key}"
            t["row"] = rid
            m.rows[rid] = Row(id=rid, comp=g.id, kind="leak", when={"in": {"any": True}}, then={},
                              open=True, llm=g.learned, decidable=t["decidable"] and not g.learned,
                              target=dict(t), label=f"{g.label} lets {key} through")
        if g.learned:
            rid = f"fp.{g.id}"
            m.rows[rid] = Row(id=rid, comp=g.id, kind="fp", when={"in": {"any": True}},
                              then={"out": {"omission": ("const", g.fp_omission or 10)}} if "omission" in m.fields else {},
                              open=True, llm=True, label=f"{g.label} refuses a harmless message (false positive)")
