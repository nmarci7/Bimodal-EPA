# Evaluation harness

`collect.py` runs every measurement the evaluation chapter of the paper reports, on one engine commit, and writes the results where the paper reads them. `sim.py` is a second reading of the firing rule. Listing 4.1 of the paper is `tests/models/paper_listing.yaml`, and `tests/test_fifo.py` checks that it gives the paper's verdicts.

## What the paper's numbers come from

`results.tex` records the commit it was measured on, and the paper prints it. The code is submitted with the paper as a zip. To rerun, from a clean checkout of that commit:

```bash
<python> eval/collect.py --paper <paper checkout> --python <python> --repeats 3 --max-seconds 120
```

The tag `tdk26-eval` marks the earlier state of 30 October (one copy per edge and token value, reduced tokens, no sub-kind defaults), which the paper uses as its before figures.

`<python>` is the interpreter with `requirements.txt` installed; it runs the script as well as the benchmark. Without `--python`, the script looks for `.venv/bin/python` in the engine checkout. Without `--engine`, it measures the checkout it sits in. A rerun overwrites `results.tex`, and it warns if the checkout has uncommitted changes. Timings depend on the machine; the states and the verdicts should not.

## What it writes, under `<paper>/data/eval/`

| File | Read by |
| --- | --- |
| `results.tex` | `include/tdk-macros.tex` inputs it; `\ev{key}` prints a value, and a missing value prints as a red placeholder |
| `scaling.csv` | the open rows of one cone against cold analysis time |
| `raw/*.json` | the source of every value: environment, bench runs, stage reports |

Use `--only env,bench,stages` to run a subset, for example `--only stages` after a case model changes. `--only diff` adds the differential test, which the paper no longer reports and which covers the `rounds` translator only.

## Keys the chapter uses

| Keys | Source |
| --- | --- |
| `env-*` | `environment()` |
| `{hub,wallet,coding}-{cells,cone-rows,states,cold,evidence-max,change-max,warm-max}`, `bench-repeats` | `bench/bench.py` B4, medians |
| `sweep-max-{rows,s,states}`, `scaling.csv` | `bench/bench.py` B1, medians |
| `ready-{k}-{s,states}`, `ready-max-{k,s,states}` | `bench/bench.py` B5, medians |
| `rq4-*`, `reasons-check`, `{case}-{stage}-{g,h,u,e,x,c}` | `derived()` and the stage verdict counts |
| `cut-cells`, `{hub,wallet,coding}-cut` | `derived()`: the design-time cells whose runs had a delivery cut by the loop bound |

## The simulator

```bash
python eval/sim.py --vectors 30
```

For a sample of switch vectors per cone, `sim.py` walks every firing order in Python and compares the end states with what TLC finds, per use case and vector. It shares no code with the generated module, but it takes the loaded model and the cones from the engine, so it tests the firing translator and not those. It compares the end states and the deliveries the loop bound cut. It knows only the present/absent scale. Each run prints its pair count and the number of differences, and exits with 1 if any pair differs.
