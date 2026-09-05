#!/usr/bin/env python3
"""
Score arm 1a' against the pre-registered rule. No new measurement happens here;
this only reads runs/*.json and applies the arithmetic that was fixed first.

Pre-registered endpoints, in order:
  PRIMARY   bar_met -- the agent's regression test FAILS on the original
            defective code and PASSES on its own fix. "Fails before, passes
            after", stated directly.
  SECONDARY mutation score of the agent's suite, over mutants the hidden
            reference suite provably kills.
  SECONDARY fix_meets_spec -- the fix satisfies the hidden suite.

Pairing is by (spec, pass): the same specification, the same pass number, one
configuration each. Passes are NOT pooled -- pooling was the generous rule that
made an earlier p-value unquotable in this repository.
"""
import json, glob, os, math, itertools, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))


def load(pattern):
    out = {}
    for f in sorted(glob.glob(os.path.join(HERE, os.environ.get("RUNS_DIR","runs"), pattern))):
        d = json.load(open(f))
        for r in d["rows"]:
            out[(r["spec"], d["config"], d["pass"])] = r
    return out


def mcnemar_exact(b, c):
    """Two-sided exact binomial on the discordant pairs."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) / (2 ** n)
    return min(1.0, 2 * tail)


rows = load("brownfield-*.json")
if not rows:
    raise SystemExit("no runs found under runs/")

specs = sorted({k[0] for k in rows})
passes = sorted({k[2] for k in rows})

# ---- validity ----------------------------------------------------------------
invalid = {k: v for k, v in rows.items() if v.get("error") or v.get("bar_met") is None}
print(f"cells loaded: {len(rows)}   specs: {len(specs)}   passes: {passes}")
if invalid:
    print(f"INVALID (excluded from the denominator, published here): {len(invalid)}")
    for k, v in sorted(invalid.items()):
        print(f"   {k}  {v.get('error') or 'no scorable output'}")
print()

# ---- primary: bar_met --------------------------------------------------------
print("PRIMARY -- fails-before-and-passes-after")
per_cfg = {}
for cfg in ("off", "on"):
    vals = [v["bar_met"] for k, v in rows.items() if k[1] == cfg and v.get("bar_met") is not None]
    per_cfg[cfg] = vals
    if vals:
        print(f"  {cfg:3s}  {sum(vals)}/{len(vals)} = {sum(vals)/len(vals):.1%}")

b = c = concordant = 0
pairs = []
for s, p in itertools.product(specs, passes):
    o = rows.get((s, "off", p))
    n = rows.get((s, "on", p))
    if not o or not n or o.get("bar_met") is None or n.get("bar_met") is None:
        continue
    pairs.append((s, p, o["bar_met"], n["bar_met"]))
    if o["bar_met"] and not n["bar_met"]:
        b += 1
    elif n["bar_met"] and not o["bar_met"]:
        c += 1
    else:
        concordant += 1
print(f"  paired on (spec, pass): {len(pairs)}   concordant {concordant}   "
      f"off-only {b}   on-only {c}")
print(f"  McNemar exact p = {mcnemar_exact(b, c):.4f}")
print()

# ---- secondary: mutation score ----------------------------------------------
print("SECONDARY -- mutation score (mean of passes, per spec)")
diffs = []
for s in specs:
    o = [rows[(s, "off", p)]["mutation_score"] for p in passes
         if (s, "off", p) in rows and rows[(s, "off", p)].get("mutation_score") is not None]
    n = [rows[(s, "on", p)]["mutation_score"] for p in passes
         if (s, "on", p) in rows and rows[(s, "on", p)].get("mutation_score") is not None]
    if not o or not n:
        continue
    om, nm = st.mean(o), st.mean(n)
    diffs.append(nm - om)
    print(f"  {s:12s} off={om:.3f}  on={nm:.3f}  delta={nm-om:+.3f}")
if diffs:
    print(f"  mean delta (on - off) = {st.mean(diffs):+.3f}   "
          f"specs improved {sum(1 for d in diffs if d > 0)}, "
          f"worsened {sum(1 for d in diffs if d < 0)}, "
          f"unchanged {sum(1 for d in diffs if d == 0)}")
print()

# ---- secondary: does the fix meet the spec ----------------------------------
print("SECONDARY -- fix satisfies the hidden reference suite")
for cfg in ("off", "on"):
    vals = [v.get("fix_meets_spec") for k, v in rows.items()
            if k[1] == cfg and v.get("fix_meets_spec") is not None]
    if vals:
        print(f"  {cfg:3s}  {sum(vals)}/{len(vals)} = {sum(vals)/len(vals):.1%}")

secs = [v["seconds"] for v in rows.values() if v.get("seconds")]
if secs:
    print(f"\nwall-clock per run: median {st.median(secs):.0f}s  max {max(secs):.0f}s")
