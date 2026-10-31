"""Generated rows: the worst-case table (of every LLM component, or of every component when the model
says `worst_case_defaults: all`) and the rows every guard carries."""

# What `worst_case_defaults` may say: `llm` (the default) gives the worst-case table to LLM components
# only; `all` gives it to every component, FPTC style, so an unmodelled component is never a guarantee.
WORST_CASE = ("llm", "all")

# k when the model states none: an edge carries one token value at most this many times in a run.
LOOP_BOUND = 2

# What a worst-case default emits: the mode or sub-kind, present. The rounds translator reads a default as magnitude
# ROUNDS_TOP instead, the old top of the scale, which the reference semantics of the differential test uses.
PRESENT = 1
ROUNDS_TOP = 10


def replaces_default(comp, r, port, mode):
    """An analyst row refines the default (port, mode) in place only if it keeps the default's trigger -
    any input, any message - and emits that same mode or sub-kind there. Any narrower row (a failure
    pattern, a fork-join, one port of several) would say that the component does not start the
    failure on its own, which only a recorded structural reason may say; such a row goes beside the
    default."""
    if r.kind != "row" or mode not in r.then.get(port, {}):
        return False
    w = r.when
    if w == {"*": {"any": True}}:
        return True
    return len(comp.ins) == 1 and w == {comp.ins[0]: {"any": True}}


def has_defaults(doc, cdoc):
    """Whether a component of the document gets the worst-case table: every LLM component does; with
    `worst_case_defaults: all` every component does."""
    return cdoc.get("kind") == "llm" or doc.get("worst_case_defaults", "llm") == "all"


def add_worst_case_defaults(m):
    """A component with defaults (`has_defaults`) starts with a worst-case table: for each output port
    and each mode and sub-kind, `any message => that failure, present`, open. Each sub-kind has a row of
    its own, because a guard catches one sub-kind and drops the token: one row carrying them all would
    let a guard on one sub-kind hide the others. An analyst row with the same trigger that emits the same
    failure on the same port replaces it (a magnitude on a refined scale is recorded as a calibration);
    every other analyst row is added beside it; a default may be dropped only with a recorded reason, and
    a dropped mode keeps the defaults of its sub-kinds. An LLM component's default falls under the LLM
    rule (never "never"); any other component's default may be certified never, which is how evidence
    earns a guarantee for a component nobody modelled."""
    from .cone import default_schedule
    from .load import Row
    # the rounds translator keeps the reference semantics, which has defaults for the top-level modes only
    failures = m.top_modes if default_schedule() == "rounds" else m.fields
    for cdoc in m.doc["components"]:
        if not has_defaults(m.doc, cdoc):
            continue
        cid = cdoc["id"]
        comp = m.components[cid]
        dropped = {(d["port"], d["mode"]): d["reason"] for d in cdoc.get("drop_defaults", [])}
        for port in comp.outs:
            covered = {}
            for r in m.comp_rows(cid):
                for mode in failures:
                    if replaces_default(comp, r, port, mode):
                        covered.setdefault(mode, r)
            for mode, r in covered.items():
                op, k = r.then[port][mode]
                if op == "const" and k != PRESENT:
                    m.decisions.append({"kind": "calibrate-default", "component": cid, "port": port, "mode": mode,
                                        "row": r.id, "from": PRESENT, "to": k,
                                        "reason": r.reason or r.label or "calibrated by the analyst"})
            for mode in failures:
                if mode in covered:
                    continue
                if (port, mode) in dropped:
                    m.decisions.append({"kind": "drop-default", "component": cid, "port": port, "mode": mode,
                                        "reason": dropped[(port, mode)]})
                    continue
                rid = f"default.{cid}.{port}.{mode}"
                m.rows[rid] = Row(id=rid, comp=cid, kind="default", when={"*": {"any": True}},
                                  then={port: {mode: ("const", PRESENT)}}, open=True, llm=comp.llm,
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
                              then={"out": {"omission": ("const", g.fp_omission or PRESENT)}} if "omission" in m.fields else {},
                              open=True, llm=True, label=f"{g.label} refuses a harmless message (false positive)")
