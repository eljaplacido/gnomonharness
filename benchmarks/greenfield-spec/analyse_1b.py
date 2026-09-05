#!/usr/bin/env python3
"""
Score arm 1b (the `writing-tests.md` skill, off vs on) against the pre-registered
rule. Reads runs/greenfield-*.json; performs no new measurement.

PRIMARY   mutation score of the agent's own tests, over mutants the hidden
          reference suite provably kills. Continuous, so a paired signed-rank
          test over specs rather than McNemar over trials.
SECONDARY meets_spec -- the implementation satisfies the hidden suite.
"""
import json, glob, os, math, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.environ.get("RUNS_DIR", "runs")


def load():
    out = {}
    for f in sorted(glob.glob(os.path.join(HERE, RUNS, "greenfield-*.json"))):
        d = json.load(open(f))
        for r in d["rows"]:
            out[(r["spec"], d["config"], d["pass"])] = r
    return out


def wilcoxon_exact(diffs):
    """Two-sided exact signed-rank p. Zero differences dropped, as is standard."""
    d = [x for x in diffs if x != 0]
    n = len(d)
    if n == 0:
        return 1.0, 0
    order = sorted(range(n), key=lambda i: abs(d[i]))
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and abs(d[order[j + 1]]) == abs(d[order[i]]):
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    w_plus = sum(ranks[i] for i in range(n) if d[i] > 0)
    # Exact null: every sign assignment equally likely.
    total = 0
    count = 0
    for mask in range(1 << n):
        s = sum(ranks[i] for i in range(n) if mask & (1 << i))
        total += 1
        if s <= min(w_plus, sum(ranks) - w_plus) or s >= max(w_plus, sum(ranks) - w_plus):
            count += 1
    return min(1.0, count / total), n


rows = load()
if not rows:
    raise SystemExit("no arm-1b runs found")
specs = sorted({k[0] for k in rows})
passes = sorted({k[2] for k in rows})
print(f"cells loaded: {len(rows)}   specs: {len(specs)}   passes: {passes}\n")

print("PRIMARY -- mutation score (mean of passes, per spec)")
diffs = []
for s in specs:
    o = [rows[(s, "off", p)]["mutation_score"] for p in passes
         if (s, "off", p) in rows and rows[(s, "off", p)].get("mutation_score") is not None]
    n = [rows[(s, "on", p)]["mutation_score"] for p in passes
         if (s, "on", p) in rows and rows[(s, "on", p)].get("mutation_score") is not None]
    if not o or not n:
        print(f"  {s:12s} incomplete -- excluded")
        continue
    om, nm = st.mean(o), st.mean(n)
    diffs.append(nm - om)
    print(f"  {s:12s} off={om:.3f}  on={nm:.3f}  delta={nm-om:+.3f}")
if diffs:
    p, nz = wilcoxon_exact(diffs)
    print(f"\n  mean delta (on - off) = {st.mean(diffs):+.4f}   sd = {st.pstdev(diffs):.4f}")
    print(f"  improved {sum(1 for d in diffs if d>0)}, worsened {sum(1 for d in diffs if d<0)}, "
          f"unchanged {sum(1 for d in diffs if d==0)}")
    print(f"  Wilcoxon signed-rank, exact, two-sided: p = {p:.4f}  (n = {nz} non-zero pairs)")

print("\nWITHIN-ARM SPREAD -- the noise this had to clear")
for cfg in ("off", "on"):
    per = []
    for s in specs:
        v = [rows[(s, cfg, p)]["mutation_score"] for p in passes
             if (s, cfg, p) in rows and rows[(s, cfg, p)].get("mutation_score") is not None]
        if len(v) == 2:
            per.append(abs(v[0] - v[1]))
    if per:
        print(f"  {cfg:3s} mean |pass1 - pass2| per spec = {st.mean(per):.4f}  max = {max(per):.4f}")

print("\nSECONDARY -- implementation satisfies the hidden reference suite")
for cfg in ("off", "on"):
    v = [r.get("meets_spec") for k, r in rows.items() if k[1] == cfg and r.get("meets_spec") is not None]
    if v:
        print(f"  {cfg:3s}  {sum(v)}/{len(v)} = {sum(v)/len(v):.1%}")
