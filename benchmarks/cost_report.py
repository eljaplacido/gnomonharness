#!/usr/bin/env python3
"""B3 — cost of running the internal 5-task suite, per harness.

Turns the already-measured per-harness token counts (benchmarks/results/*.json)
into a dollar cost, so gnomon's token-efficiency reads as "what it costs to run
the suite" rather than an abstract ratio. Since every harness is compared on the
SAME model, the price cancels in the ratio — the absolute $ just makes it
concrete. Reference prices ($/1M tokens, input/output) are applied uniformly.
"""
import json, glob
from collections import defaultdict

# Reference cloud prices ($ per 1M tokens) applied to the measured token counts.
# The RATIO between harnesses is price-independent; these make it a dollar figure.
PRICES = {  # (in, out) $/Mtok
    "claude-sonnet-5": (3.0, 15.0),
    "gpt-5.3-codex": (2.5, 10.0),
    "qwen3.6-35b": (0.20, 0.60),   # a typical hosted open-model price
    "qwen2.5-7b": (0.05, 0.10),
}

def load():
    rows = []
    for f in sorted(glob.glob("benchmarks/results/*.json")):
        model = f.split("/")[-1][:-5]
        d = json.load(open(f))
        runs = d.get("runs", [])
        if isinstance(runs, dict):
            runs = list(runs.values())
        for r in runs:
            if not isinstance(r, dict):
                continue
            rows.append(dict(model=model, harness=r.get("harness"), task=r.get("task"),
                             ti=r.get("tokens_in") or 0, to=r.get("tokens_out") or 0,
                             ok=bool(r.get("ok"))))
    return rows

def cost(model, ti, to):
    pin, pout = PRICES.get(model, (0.0, 0.0))
    return ti / 1e6 * pin + to / 1e6 * pout

def main():
    rows = [r for r in load() if r["harness"] and r["model"] in PRICES]
    models = sorted({r["model"] for r in rows})
    print("# Cost to run the internal 5-task suite, per harness\n")
    print("Applied reference prices ($/1M tok in/out): " +
          ", ".join(f"{m} {PRICES[m]}" for m in models) + "\n")
    for model in models:
        rs = [r for r in rows if r["model"] == model]
        harn = sorted({r["harness"] for r in rs})
        print(f"## {model}")
        print(f"{'harness':<10} {'tok_in':>9} {'tok_out':>8} {'$ / suite-run':>13} {'solved':>7} {'$/solved':>9} {'vs gnomon':>10}")
        base = None
        table = {}
        for h in harn:
            hr = [r for r in rs if r["harness"] == h]
            trials = max((sum(1 for r in rs if r["harness"] == h and r["task"] == t)) for t in {r["task"] for r in hr}) or 1
            ti = sum(r["ti"] for r in hr); to = sum(r["to"] for r in hr)
            c = cost(model, ti, to)
            solved = sum(1 for r in hr if r["ok"])
            # normalise to one full pass of the suite (5 tasks): cost per trial-set
            c_run = c / trials
            table[h] = dict(ti=ti // trials, to=to // trials, c=c_run, solved=solved, trials=trials)
        base = table.get("gnomon", {}).get("c")
        for h in sorted(table, key=lambda x: table[x]["c"]):
            t = table[h]
            ratio = (t["c"] / base) if base else None
            sps = (t["c"] / max(1, t["solved"] / t["trials"])) if t["solved"] else None
            print(f"{h:<10} {t['ti']:>9} {t['to']:>8} {'$'+format(t['c'],'.4f'):>13} "
                  f"{t['solved']:>7} {('$'+format(sps,'.4f')) if sps else 'n/a':>9} "
                  f"{(format(ratio,'.1f')+'x') if ratio else '—':>10}")
        print()
    # headline: gnomon vs opencode token ratio (price-independent)
    print("## Headline: gnomon vs opencode (same model, so this is the pure token/cost ratio)")
    for model in models:
        rs = [r for r in rows if r["model"] == model]
        g = [r for r in rs if r["harness"] == "gnomon"]
        o = [r for r in rs if r["harness"] == "opencode"]
        if not g or not o:
            continue
        gtot = sum(r["ti"] + r["to"] for r in g); otot = sum(r["ti"] + r["to"] for r in o)
        gcost = sum(cost(model, r["ti"], r["to"]) for r in g)
        ocost = sum(cost(model, r["ti"], r["to"]) for r in o)
        print(f"  {model:<16} opencode uses {otot/max(1,gtot):.1f}x gnomon's tokens "
              f"-> {ocost/max(1e-9,gcost):.1f}x the cost to run the suite")

if __name__ == "__main__":
    main()
