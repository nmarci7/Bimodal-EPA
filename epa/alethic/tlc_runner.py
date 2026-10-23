"""Run TLC on a generated module.

TLC is Java. This module writes the module and its configuration into a folder named after the hash
of their text (so the same request is answered from disk), copies the hand-written library next to
them, and starts `java -cp tla2tools.jar tlc2.TLC -deadlock -dump states ...` as a subprocess.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "tla_lib", "EpaLib.tla")


def find_jar():
    for cand in (os.environ.get("TLA2TOOLS"),
                 os.path.join(HERE, "..", "..", "vendor", "tla2tools.jar"),
                 os.path.join(os.getcwd(), "vendor", "tla2tools.jar")):
        if cand and os.path.exists(cand):
            return os.path.abspath(cand)
    raise FileNotFoundError("tla2tools.jar not found: put it in vendor/ or set TLA2TOOLS")


def java_ok():
    try:
        out = subprocess.run(["java", "-version"], capture_output=True, text=True, timeout=20)
        return out.returncode == 0, (out.stderr or out.stdout).splitlines()[0] if (out.stderr or out.stdout) else ""
    except Exception as e:  # noqa: BLE001
        return False, str(e)


class TLCError(RuntimeError):
    pass


def run(module_text, cfg_text, workroot, name="Cone", workers="auto", timeout=900):
    h = hashlib.sha256((module_text + cfg_text + open(LIB).read()).encode()).hexdigest()[:16]
    wd = os.path.join(workroot, "tlc", h)
    dump = os.path.join(wd, "states.dump")
    stats_path = os.path.join(wd, "stats.txt")
    if os.path.exists(dump) and os.path.exists(stats_path):
        stats = _parse_stats(open(stats_path).read())
        stats.update(cached=True, dir=wd, hash=h)
        return dump, stats
    os.makedirs(wd, exist_ok=True)
    with open(os.path.join(wd, f"{name}.tla"), "w") as f:
        f.write(module_text)
    with open(os.path.join(wd, f"{name}.cfg"), "w") as f:
        f.write(cfg_text)
    shutil.copy(LIB, os.path.join(wd, "EpaLib.tla"))
    cmd = ["java", "-XX:+UseParallelGC", "-Xss16m", "-cp", find_jar(), "tlc2.TLC", "-deadlock",
           "-workers", str(workers), "-dump", "states", "-config", f"{name}.cfg", "-metadir",
           os.path.join(wd, "meta"), f"{name}.tla"]
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=wd, capture_output=True, text=True, timeout=timeout)
    out = proc.stdout + proc.stderr
    if "No error has been found" not in out and "Model checking completed" not in out:
        raise TLCError("TLC failed:\n" + out[-4000:])
    with open(stats_path, "w") as f:
        f.write(out)
    shutil.rmtree(os.path.join(wd, "meta"), ignore_errors=True)
    stats = _parse_stats(out)
    stats.update(cached=False, dir=wd, hash=h, seconds=round(time.time() - t0, 2))
    return dump, stats


def _parse_stats(out):
    s = {}
    m = re.search(r"([\d,]+) states generated, ([\d,]+) distinct states found", out)
    if m:
        s["generated"] = int(m.group(1).replace(",", ""))
        s["distinct"] = int(m.group(2).replace(",", ""))
    m = re.search(r"depth of the complete state graph search is (\d+)", out)
    if m:
        s["depth"] = int(m.group(1))
    m = re.search(r"Finished computing initial states: ([\d,]+) distinct state", out)
    if m:
        s["initial"] = int(m.group(1).replace(",", ""))
    m = re.search(r"TLC2 Version ([^\s]+)", out)
    if m:
        s["tlc_version"] = m.group(1)
    return s
