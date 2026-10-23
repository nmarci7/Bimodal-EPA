"""Generated rows: the LLM worst-case table and the rows every guard carries."""


def add_llm_defaults(m):
    """Every LLM component starts with a worst-case table: for each output port and each top-level
    mode, `any message => mode const 10`. An analyst row on the same port and mode refines (replaces)
    the default; a default may be dropped only with a recorded reason (`drop_defaults`)."""
    from .load import Row
    for cdoc in m.doc["components"]:
        if cdoc["kind"] != "llm":
            continue
        cid = cdoc["id"]
        comp = m.components[cid]
        dropped = {(d["port"], d["mode"]): d["reason"] for d in cdoc.get("drop_defaults", [])}
        for port in comp.outs:
            covered = set()
            for r in m.comp_rows(cid):
                for mname in r.then.get(port, {}):
                    covered.add(mname)
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
