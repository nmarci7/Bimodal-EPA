"""Run every measurement the evaluation chapter (Chapter 5) reports, on one engine commit, and
write them where the paper reads them.

    python eval/collect.py --paper <paper checkout> [--engine <checkout, default this one>]
                           [--only env,bench,stages] [--repeats 5] [--max-seconds 600]

Nothing is measured until this is run. The paper prints a red placeholder for every value it
has not received, so a missing number is visible in the PDF.

Outputs, under <paper>/data/eval/:
  results.tex   \\evset{key}{value} lines; the chapter prints them with \\ev{key}
  scaling.csv   open rows of one cone against cold analysis time (Figure fig:scaling)
  raw/          the JSON every value came from, with the machine and the versions

The engine is only read and run, never changed. Run it on the commit that is tagged for the
Zenodo release: results.tex records that commit, and Section 5.3 prints it.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------------------------
# environment: machine, versions, commit
# ---------------------------------------------------------------------------------------------

def sh(cmd, cwd=None):
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=60).stdout.strip()
    except Exception as e:  # noqa: BLE001 - a missing tool is recorded, not fatal
        return f"unavailable ({e.__class__.__name__})"


def cpu_name():
    if sys.platform == "darwin":
        return sh(["sysctl", "-n", "machdep.cpu.brand_string"])
    try:
        for line in open("/proc/cpuinfo"):
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor()


def memory_gb():
    try:
        if sys.platform == "darwin":
            return round(int(sh(["sysctl", "-n", "hw.memsize"])) / 2**30)
        return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30)
    except (ValueError, OSError):
        return None


def environment(engine, python):
    java = subprocess.run(["java", "-version"], capture_output=True, text=True)
    jar = os.path.join(engine, "vendor", "tla2tools.jar")
    tlc = sh(["java", "-cp", jar, "tlc2.TLC", "-version"]) if os.path.exists(jar) else "missing"
    m = re.search(r"Version\s+([\w.\-]+)", tlc)
    return {
        "engine_commit": sh(["git", "rev-parse", "--short", "HEAD"], cwd=engine),
        "engine_tag": sh(["git", "describe", "--tags", "--exact-match"], cwd=engine) or "untagged",
        "engine_dirty": bool(sh(["git", "status", "--porcelain"], cwd=engine)),
        "cpu": cpu_name(), "cores": os.cpu_count(), "memory_gb": memory_gb(),
        "os": f"{platform.system()} {platform.release()}",
        "python": sh([python, "-c", "import sys; print(sys.version.split()[0])"]),
        "clingo": sh([python, "-c", "import clingo; print(clingo.__version__)"]),
        "java": (java.stderr or java.stdout).splitlines()[0] if (java.stderr or java.stdout) else "missing",
        "tlc": m.group(1) if m else tlc[:60],
        "date": time.strftime("%Y-%m-%d"),
    }


# ---------------------------------------------------------------------------------------------
# RQ1: differential test against the reference semantics
# ---------------------------------------------------------------------------------------------

def differential(engine, python, seeds, raw):
    report = os.path.join(raw, "differential.json")
    env = {**os.environ, "EPA_ENGINE_ROOT": engine, "EPA_DIFF_SEEDS": str(seeds), "EPA_DIFF_REPORT": report}
    t0 = time.time()
    p = subprocess.run([python, "-m", "pytest", "-q", "tests/test_differential.py", "-p", "no:cacheprovider"],
                       cwd=engine, env=env, capture_output=True, text=True)
    out = {"seconds": round(time.time() - t0, 1), "exit": p.returncode,
           "summary": (p.stdout.strip().splitlines() or [""])[-1]}
    if os.path.exists(report):
        s = json.load(open(report))["summary"]
        out.update({"models": s["seeds"], "cells": s["cells"], "errors": s["engine_errors"],
                    "sound": s["cells"] - s["sound_mismatches"], "exact": s["cells"] - s["exact_mismatches"],
                    "explained": s["exact_explained"], "unexplained": s["exact_unexplained"]})
    return out


# ---------------------------------------------------------------------------------------------
# RQ2: the engine's own benchmark (B1 open rows, B4 the cases stage by stage, cold and warm)
# ---------------------------------------------------------------------------------------------

def bench(engine, python, raw, repeats, max_seconds):
    runs = []
    for i in range(repeats):
        path = os.path.join(raw, f"bench-{i}.json")
        subprocess.run([python, "bench/bench.py", "--root", ".", "--out", path, "--only", "B1,B4,B5",
                        "--max-seconds", str(max_seconds)], cwd=engine, check=True)
        runs.append(json.load(open(path)))
    return runs


def bench_values(runs):
    """Medians over the repetitions: per case cold design time, warm stages, the redesign stage."""
    vals, csv = {}, []
    b4 = [r.get("B4_cases", []) for r in runs]
    keys = {(x["case"], x["stage"], x["warm"]) for x in b4[0]} if b4 and b4[0] else set()
    med = {k: statistics.median([x["total_s"] for r in b4 for x in r if (x["case"], x["stage"], x["warm"]) == k])
           for k in keys}
    short = {"smart-home": "hub", "wallet": "wallet", "mcp-coding-agent": "coding"}
    for case, s in short.items():
        stages = sorted({k[1] for k in keys if k[0] == case})
        if not stages:
            continue
        vals[f"{s}-cold"] = f"{med[(case, stages[0], False)]:.1f}"
        vals[f"{s}-warm-max"] = f"{max(med[(case, st, True)] for st in stages):.1f}"
        evid = [med[(case, st, False)] for st in stages[1:]]
        vals[f"{s}-stage-max"] = f"{max(evid):.1f}" if evid else "--"
        first = next(x for x in b4[0] if x["case"] == case and x["stage"] == stages[0] and not x["warm"])
        vals[f"{s}-cells"] = str(first["cells"])
        vals[f"{s}-cone-rows"] = str(first["largest_cone_rows"])
        vals[f"{s}-states"] = f"{first['distinct_states']:,}"
    b1 = [r.get("B1_chain_rows", []) for r in runs]
    if b1 and b1[0]:
        by_rows = {}  # B1: k guarded sub-kinds, so a cone of 2k open rows
        for r in b1:
            for x in r:
                by_rows.setdefault(x["largest_cone_rows"], []).append(x["total_s"])
        for rows in sorted(k for k in by_rows if k is not None):
            csv.append((rows, statistics.median(by_rows[rows])))
        last = [x for x in b1[0] if x["largest_cone_rows"] == csv[-1][0]][0] if csv else None
        if last:
            vals["sweep-max-states"] = f"{last['distinct_states']:,}"
        vals["sweep-max-rows"] = str(csv[-1][0]) if csv else "--"
        vals["sweep-max-s"] = f"{csv[-1][1]:.1f}" if csv else "--"
    b5 = [r.get("B5_ready", []) for r in runs]
    if b5 and b5[0]:
        ks = sorted({x["x"] for r in b5 for x in r})
        complete = [k for k in ks if all(any(x["x"] == k for x in r) for r in b5)]
        by = {k: statistics.median([x["total_s"] for r in b5 for x in r if x["x"] == k]) for k in complete}
        states = {k: next(x["distinct_states"] for x in b5[0] if x["x"] == k) for k in complete}
        for k in complete:
            vals[f"ready-{k}-s"] = f"{by[k]:.1f}"
            vals[f"ready-{k}-states"] = f"{states[k]:,}"
        vals["ready-max-k"] = str(complete[-1])
        vals["ready-max-s"] = f"{by[complete[-1]]:.1f}"
        vals["ready-max-states"] = f"{states[complete[-1]]:,}"
    return vals, csv


def bench_split(engine, raw):
    """Later stages split by kind, from the saved bench runs: evidence-only stages (certificates,
    logs, decisions) against stages that change the model (a new model or new component versions)."""
    import glob
    import yaml
    runs = [json.load(open(f)) for f in sorted(glob.glob(os.path.join(raw, "bench-*.json")))]
    short = {"smart-home": "hub", "wallet": "wallet", "mcp-coding-agent": "coding"}
    vals = {}
    for case, s in short.items():
        meta = yaml.safe_load(open(os.path.join(engine, "cases", case, "case.yaml")))
        change = {st["id"] for st in meta["stages"] if "model" in st or "versions" in st}
        later = [st["id"] for st in meta["stages"]][1:]
        def med(stage):
            return statistics.median([x["total_s"] for r in runs for x in r.get("B4_cases", [])
                                      if x["case"] == case and x["stage"] == stage and not x["warm"]])
        ev = [med(st) for st in later if st not in change]
        mc = [med(st) for st in later if st in change]
        vals[f"{s}-evidence-max"] = f"{max(ev):.1f}" if ev else "--"
        vals[f"{s}-change-max"] = f"{max(mc):.1f}" if mc else "--"
    return vals


# ---------------------------------------------------------------------------------------------
# RQ1/RQ3: what each scenario stage ends in
# ---------------------------------------------------------------------------------------------

def stages(engine, raw):
    sys.path.insert(0, engine)
    from epa.engine.coordinator import Engine            # noqa: E402
    from epa.engine.scenario import load_case, stage_inputs  # noqa: E402
    from epa.model.load import load_model                # noqa: E402
    out = []
    for case in ("smart-home", "wallet", "mcp-coding-agent"):
        cdir = os.path.join(engine, "cases", case)
        work = tempfile.mkdtemp(prefix=f"epa-eval-{case}-")
        for st in load_case(cdir).get("stages", []):
            doc, ev, _ = stage_inputs(cdir, st["id"])
            rep = Engine(load_model(doc), work).analyse(ev, rank=True)
            counts = {}
            for c in rep["cells"]:
                counts[c["verdict"]] = counts.get(c["verdict"], 0) + 1
            out.append({"case": case, "stage": st["id"], "label": st.get("label", ""), "verdicts": counts,
                        "cells": {c["cell"]: {"verdict": c["verdict"], "statuses": c.get("statuses"),
                                              "suspended": c.get("suspended", []),
                                              "remaining": (c.get("candidates") or {}).get("remaining"),
                                              "has_reason": bool(c.get("reasons")),
                                              "structural": bool((c.get("reasons") or {}).get("structural")),
                                              "order_dependent": c.get("order_dependent"),
                                              "advice": c.get("advice"),
                                              "fidelity": c.get("fidelity"),
                                              "certs_used": c.get("certs_used", []),
                                              "scope_withheld": [w["certificate"] for w in c.get("scope_withheld", [])],
                                              "reason_certs": (c.get("reasons") or {}).get("certificates", [])}
                                  for c in rep["cells"]},
                        "ranking": {"+".join(a["action"]): a["key"] for a in rep.get("ranking") or []},
                        "cert_states": {c["id"]: [c["state"], c.get("reason", "")] for c in rep["register"]["certificates"]},
                        "tlc_explored": sum(1 for t in rep["tlc_calls"] if not t.get("cached")),
                        "cones": len(rep["cones"]),
                        "register": {"certificates": {c["id"]: c["state"] for c in rep["register"]["certificates"]},
                                     "witnesses": {w["id"]: w["state"] for w in rep["register"]["witnesses"]}},
                        "suspension": rep.get("suspension"), "reverify": rep.get("reverify")})
        shutil.rmtree(work, ignore_errors=True)
    out.append(misplaced_guard(engine))
    json.dump(out, open(os.path.join(raw, "stages.json"), "w"), indent=1)
    vals = derived(out)
    short = {"smart-home": "hub", "wallet": "wallet", "mcp-coding-agent": "coding"}
    for x in out:
        if x["case"] not in short:
            continue
        v = x["verdicts"]
        vals[f"{short[x['case']]}-{x['stage']}-mix"] = "/".join(
            str(v.get(k, 0)) for k in ("guarantee", "hope", "unchecked", "exposed"))
        for k in ("guarantee", "hope", "unchecked", "exposed", "not exercised", "conflict"):
            vals[f"{short[x['case']]}-{x['stage']}-{k[0] if k != 'not exercised' else 'x'}"] = str(v.get(k, 0))
        vals[f"{short[x['case']]}-{x['stage']}-conflicts"] = str(len((x.get("suspension") or {}).get("conflicts", [])))
    return vals


def misplaced_guard(engine):
    """Section 4.6's what-if: the wallet's mandate check moved onto the invoice intake, before the agent."""
    from epa.engine.coordinator import Engine
    from epa.engine.scenario import stage_inputs
    from epa.model.load import load_model
    doc, ev, _ = stage_inputs(os.path.join(engine, "cases", "wallet"), "S0")
    for g in doc.get("guards", []):
        if g["id"] == "gm":
            g["edge"] = "e_invoice"
    work = tempfile.mkdtemp(prefix="epa-eval-misplaced-")
    rep = Engine(load_model(doc), work).analyse(ev, rank=True)
    shutil.rmtree(work, ignore_errors=True)
    return {"case": "wallet-misplaced", "stage": "S0",
            "cells": {c["cell"]: {"verdict": c["verdict"], "statuses": c.get("statuses"),
                                  "remaining": (c.get("candidates") or {}).get("remaining"),
                                  "root_causes": c.get("root_causes")} for c in rep["cells"]},
            "ranking": {"+".join(a["action"]): a["key"] for a in rep.get("ranking") or []}}


def cell(stage, prefix):
    """The cell of a stage whose id starts with prefix (e.g. "oom@" for the out-of-mandate payment)."""
    return next((v for k, v in stage["cells"].items() if k.startswith(prefix)), None)


def say(c):
    if c is None:
        return "cell not found"
    s = c["verdict"]
    if c.get("statuses") and c["verdict"] == "unchecked":
        s += " {" + ",".join(c["statuses"]) + "}"
    if c.get("remaining") is not None:
        s += f" over {c['remaining']}"
    return s


def moved(prev, cur):
    ch = [f"{k.split('@')[0]}: {prev['cells'][k]['verdict']} to {v['verdict']}"
          for k, v in cur["cells"].items() if k in prev["cells"] and prev["cells"][k]["verdict"] != v["verdict"]]
    return "; ".join(ch) if ch else "no verdict moved"


def stale(stage):
    reg = stage.get("register", {})
    n = sum(1 for s in list(reg.get("certificates", {}).values()) + list(reg.get("witnesses", {}).values())
            if s == "stale")
    return f"{n} stale"


def derived(out):
    """The Observed column of the robustness table and the checks of the correctness table."""
    st = {(x["case"], x["stage"]): x for x in out}
    v = {}
    real = [x for x in out if x["case"] in ("smart-home", "wallet", "mcp-coding-agent")]
    gx = [c for x in real for c in x["cells"].values() if c["verdict"] in ("guarantee", "exposed")]
    v["reasons-check"] = f"{sum(c['has_reason'] for c in gx)} / {len(gx)}"
    w = {s: st.get(("wallet", s)) for s in ("S1", "S2", "S3", "S4", "S5")}
    if all(w.values()):
        conf = [sorted(c["certificates"]) for c in (w["S2"]["suspension"] or {}).get("conflicts", [])]
        oom2, dup2 = cell(w["S2"], "oom@"), cell(w["S2"], "dup@")
        v["wallet-S2-obs"] = f"conflict sets {conf}; out of mandate {say(oom2)}; duplicate {say(dup2)}"
        v["wallet-S2-check"] = "yes" if conf == [["c_gm"]] and oom2 and oom2["verdict"] == "hope" \
            and dup2 and dup2["verdict"] == "guarantee" else "no"
        oom3 = cell(w["S3"], "oom@")
        k3 = w["S3"]["ranking"].get("gm")
        v["wallet-S3-obs"] = f"out of mandate {say(oom3)}; ranking gives M {k3 if k3 is not None else 'no entry'}"
        v["wallet-S3-match"] = "yes" if oom3 and oom3["verdict"] == "hope" and not k3 else "no"
        v["wallet-S3-check"] = "yes" if oom3 and oom3["verdict"] == "hope" else "no"
        oom4 = cell(w["S4"], "oom@")
        v["wallet-S4-obs"] = f"out of mandate {say(oom4)}; {stale(w['S4'])}"
        v["wallet-S4-match"] = "yes" if oom4 and oom4["verdict"] == "guarantee" and stale(w["S4"]) != "0 stale" else "no"
        v["wallet-S2-match"] = v["wallet-S2-check"]
        v["wallet-S5-obs"] = f"{moved(w['S4'], w['S5'])}; {len(w['S5'].get('reverify') or [])} to re-verify"
        v["wallet-S5-check"] = "yes" if moved(w["S4"], w["S5"]) == "no verdict moved" else "no"
        v["wallet-S5-match"] = v["wallet-S5-check"]
    # RQ4: classical qualitative EPA (FPTC) on the same models at design time. With every row allowed
    # to fire, FPTC says "may" exactly where some run of the cone delivers the failure, so its "no"
    # cells are the design-time guarantees and every other exercised cell is a "may".
    s0 = [st.get((c, "S0")) for c in ("smart-home", "wallet", "mcp-coding-agent")]
    if all(s0):
        cells = [c for x in s0 for c in x["cells"].values()]
        g = [c for c in cells if c["verdict"] == "guarantee"]
        v["rq4-cells"] = str(len(cells))
        v["rq4-no"] = str(len(g))
        v["rq4-no-structural"] = str(sum(c["structural"] for c in g))
        v["rq4-no-dropped"] = str(len(g) - sum(c["structural"] for c in g))
        v["rq4-may"] = str(sum(1 for c in cells if c["verdict"] not in ("guarantee", "not exercised", "conflict")))
        for key, want in (("NS", ["N", "S"]), ("NSA", ["N", "S", "A"]), ("SA", ["S", "A"])):
            v[f"rq4-u{key}"] = str(sum(1 for c in cells if c["verdict"] == "unchecked" and c.get("statuses") == want))
        v["rq4-hope"] = str(sum(1 for c in cells if c["verdict"] == "hope"))
        v["rq4-exposed"] = str(sum(1 for c in cells if c["verdict"] == "exposed"))
        v["rq4-notex"] = str(sum(1 for c in cells if c["verdict"] == "not exercised"))
    mis = st.get(("wallet-misplaced", "S0"))
    if mis:
        c = cell(mis, "oom@")
        km = mis["ranking"].get("gm")
        v["wallet-misplaced-obs"] = f"out of mandate {say(c)}; cut sets {c.get('root_causes') if c else '?'}; ranking gives M {km if km is not None else 'no entry'}"
        v["wallet-misplaced-match"] = "yes" if c and c["verdict"] == "unchecked" and c.get("statuses") == ["S", "A"] and not km else "no"
    for case, s, key in (("smart-home", "S1", "hub-S1-obs"), ("smart-home", "S3", "hub-S3-obs"),
                         ("mcp-coding-agent", "S3", "coding-S3-obs")):
        cur, prev = st.get((case, s)), st.get((case, f"S{int(s[1]) - 1}"))
        if cur and prev:
            g = sum(1 for c in cur["cells"].values() if c["verdict"] == "guarantee")
            v[key] = f"{g} guarantees; {stale(cur)}; {cur['tlc_explored']} TLC explorations for {cur['cones']} cones; {moved(prev, cur)}"
    h1 = st.get(("smart-home", "S1"))
    if h1:
        jst = h1["cert_states"].get("judge-vendor-eval", h1["cert_states"].get(next((k for k in h1["cert_states"] if "judge" in k), ""), ["?", ""]))
        in_reason = any("gj" in str(c.get("reason_certs")) or "judge" in str(c.get("reason_certs")) for c in h1["cells"].values())
        v["hub-S1-obs"] = f"judge report {jst[0]} ({jst[1]}); judge in a reason: {'yes' if in_reason else 'no'}; " + v.get("hub-S1-obs", "")
        v["hub-S1-match"] = "yes" if jst[0] == "rejected" and not in_reason else "no"
    h3 = st.get(("smart-home", "S3"))
    if h3:
        v["hub-S3-match"] = "yes" if h3["tlc_explored"] >= h3["cones"] and cell(h3, "conf@o_egress") and cell(h3, "conf@o_egress")["verdict"] == "guarantee" and stale(h3) != "0 stale" else "no"
    c3 = st.get(("mcp-coding-agent", "S3"))
    if c3:
        pr = cell(c3, "conf@o_pr")
        v["coding-S3-match"] = "yes" if pr and pr["verdict"] == "guarantee" and stale(c3) != "0 stale" else "no"
    return v


# ---------------------------------------------------------------------------------------------

def write_tex(path, vals, env):
    lines = ["% Written by eval/collect.py. Do not edit: rerun it instead.",
             f"% engine {env.get('engine_commit')} ({env.get('engine_tag')}), {env.get('date')}"]
    for k, v in sorted({**{f"env-{k}": v for k, v in env.items()}, **vals}.items()):
        v = str(v).replace("\\", "/").replace("{", r"\{").replace("}", r"\}").replace("_", r"\_") \
            .replace("%", r"\%").replace("&", r"\&").replace("#", r"\#").replace("'", "")
        lines.append(f"\\evset{{{k}}}{{{v}}}")
    open(path, "w").write("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=os.path.dirname(HERE))
    ap.add_argument("--paper", required=True)
    ap.add_argument("--seeds", type=int, default=400)
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--max-seconds", type=float, default=600)
    ap.add_argument("--only", default="env,bench,stages")
    ap.add_argument("--python", default=None, help="the engine's interpreter (default: its .venv)")
    a = ap.parse_args()
    engine = os.path.abspath(a.engine)
    python = a.python or os.path.join(engine, ".venv", "bin", "python")
    out_dir = os.path.join(os.path.abspath(a.paper), "data", "eval")
    raw = os.path.join(out_dir, "raw")
    os.makedirs(raw, exist_ok=True)
    only = set(a.only.split(","))

    old = os.path.join(raw, "values.json")
    vals = json.load(open(old)) if os.path.exists(old) else {}
    env = environment(engine, python)
    json.dump(env, open(os.path.join(raw, "environment.json"), "w"), indent=1)
    if env["engine_dirty"]:
        print("warning: the engine checkout has uncommitted changes; the numbers will not match a tag", file=sys.stderr)

    if "diff" in only:
        d = differential(engine, python, a.seeds, raw)
        json.dump(d, open(os.path.join(raw, "differential-summary.json"), "w"), indent=1)
    if "bench" in only:
        bv, csv = bench_values(bench(engine, python, raw, a.repeats, a.max_seconds))
        vals.update(bv)
        vals["bench-repeats"] = str(a.repeats)
        with open(os.path.join(out_dir, "scaling.csv"), "w") as f:
            f.write("rows seconds\n" + "".join(f"{r} {s:.3f}\n" for r, s in csv))
    if "stages" in only:
        vals.update(stages(engine, raw))
    if "split" in only or "bench" in only:
        vals.update(bench_split(engine, raw))

    json.dump(vals, open(old, "w"), indent=1, sort_keys=True)
    write_tex(os.path.join(out_dir, "results.tex"), vals, env)
    print(f"wrote {out_dir}/results.tex ({len(vals)} values)")


if __name__ == "__main__":
    main()
