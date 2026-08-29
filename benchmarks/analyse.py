#!/usr/bin/env python3
import json, os, re, statistics as st
from collections import Counter
from pathlib import Path

# Configurable so this runs on any machine (matches benchmarks/harness.py).
ROOT = Path(os.environ.get("BENCH_ROOT", os.path.expanduser("~/.cache/gnomon-bench")))
d = json.loads((ROOT/"results_qwen36_35b.json").read_text())
runs, base, det, setup = d["runs"], d["baseline"], d["determinism"], d.get("setup_ms", {})
H = ["gnomon", "opencode", "pi", "omp"]
TASKS = ["search", "read", "arith", "edit", "multi"]

def med(xs):
    xs = [x for x in xs if isinstance(x,(int,float))]
    return round(st.median(xs)) if xs else None
def sel(rs, h=None, t=None):
    return [r for r in rs if (h is None or r["harness"]==h) and (t is None or r.get("task")==t)]
def hdr(t):
    print("\n" + "="*78); print(t); print("="*78)

hdr("1. QUALITY — criteria met / criteria possible (3 per task, n=3 trials)")
print(f"{'task':9s}" + "".join(f"{h:>17s}" for h in H))
for t in TASKS:
    row = f"{t:9s}"
    for h in H:
        rs = sel(runs,h,t)
        s = sum(r["score"] for r in rs); m = sum(r["max_score"] for r in rs)
        pct = f"{100*s/m:.0f}%" if m else "-"
        row += f"{s}/{m} ({pct})".rjust(17)
    print(row)
row = f"{'TOTAL':9s}"
for h in H:
    rs = sel(runs,h); s=sum(r['score'] for r in rs); m=sum(r['max_score'] for r in rs)
    row += f"{s}/{m} ({100*s/m:.0f}%)".rjust(17)
print(row)

hdr("2. FULL PASS — every criterion met (strict)")
print(f"{'task':9s}" + "".join(f"{h:>17s}" for h in H))
for t in TASKS:
    print(f"{t:9s}" + "".join(f"{sum(1 for r in sel(runs,h,t) if r['ok'])}/{len(sel(runs,h,t))}".rjust(17) for h in H))
print(f"{'TOTAL':9s}" + "".join(f"{sum(1 for r in sel(runs,h) if r['ok'])}/{len(sel(runs,h))}".rjust(17) for h in H))

hdr("3. TOKEN / CONTEXT EFFICIENCY")
print(f"{'metric':28s}" + "".join(f"{h:>12s}" for h in H))
print(f"{'baseline in-tokens':28s}" + "".join(
    f"{str(med([r['tokens_in'] for r in sel(base,h)])):>12s}" for h in H))
print(f"{'median in-tokens / task':28s}" + "".join(
    f"{str(med([r['tokens_in'] for r in sel(runs,h)])):>12s}" for h in H))
print(f"{'total in-tokens (15 tasks)':28s}" + "".join(
    f"{str(sum(r['tokens_in'] or 0 for r in sel(runs,h))):>12s}" for h in H))
for h in H:
    rs=[r for r in sel(runs,h) if r["ok"]]
    tot=sum(r["tokens_in"] or 0 for r in sel(runs,h))
    print(f"  {h:9s} tokens per FULL PASS: " + (f"{round(tot/len(rs)):,}" if rs else "no passes"))

hdr("4. PERFORMANCE")
print(f"{'metric':28s}" + "".join(f"{h:>12s}" for h in H))
print(f"{'median ms / task':28s}" + "".join(
    f"{str(med([r['ms'] for r in sel(runs,h)])):>12s}" for h in H))
print(f"{'median tool calls':28s}" + "".join(
    f"{str(med([r['tool_calls'] for r in sel(runs,h)])):>12s}" for h in H))
print(f"{'one-time setup ms':28s}" + "".join(
    f"{str(med(setup.get(h,[])) or 0):>12s}" for h in H))

hdr("5. DETERMINISM — same prompt, 5 identical repeats")
for t in ["search","arith"]:
    print(f"\n  task: {t}")
    print(f"    {'harness':10s}{'distinct outs':>15s}{'exact-match':>13s}{'calls spread':>14s}{'in-tok spread':>15s}")
    for h in H:
        rs = sel(det,h,t)
        if not rs: continue
        norm = [" ".join((r["out"] or "").split()).lower() for r in rs]
        uniq = len(set(norm))
        top = Counter(norm).most_common(1)[0][1] if norm else 0
        calls = [r["tool_calls"] for r in rs if isinstance(r["tool_calls"],int)]
        toks  = [r["tokens_in"] for r in rs if isinstance(r["tokens_in"],int)]
        cs = f"{min(calls)}-{max(calls)}" if calls else "-"
        ts = f"{min(toks)}-{max(toks)}" if toks else "-"
        print(f"    {h:10s}{f'{uniq}/{len(rs)}':>15s}{f'{top}/{len(rs)}':>13s}{cs:>14s}{ts:>15s}")
    print(f"    {'':10s}{'lower=steadier':>15s}{'higher=steadier':>13s}")

hdr("6. DETERMINISM OF OUTCOME — did the same prompt score the same?")
for t in ["search","arith"]:
    print(f"\n  task: {t}")
    for h in H:
        rs = sel(det,h,t)
        if not rs: continue
        scores = [r["score"] for r in rs]
        print(f"    {h:10s} scores {scores}  {'STABLE' if len(set(scores))==1 else 'VARIES'}")
