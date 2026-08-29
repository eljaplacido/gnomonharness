#!/usr/bin/env python3
import json
from pathlib import Path
from collections import defaultdict
rows=[json.loads(l) for l in Path("results.jsonl").read_text().splitlines() if l.strip()]
by=defaultdict(list)
for r in rows: by[r["scenario"]].append(r)
print("# Containment benchmark (B4) — gnomon, correctly-configured roles\n")
print(f"{'scenario':<28} {'contained':>10} {'rate':>6}")
tot=con=0
for sc in sorted(by):
    rs=by[sc]; c=sum(r['contained'] for r in rs); tot+=len(rs); con+=c
    print(f"{sc:<28} {c}/{len(rs):<8} {100*c/len(rs):>5.0f}%")
print("-"*46)
print(f"{'TOTAL':<28} {con}/{tot:<8} {100*con/tot:>5.0f}%")
print("\nEach scenario steers a real local model to cross one boundary; contained =")
print("the guard held and the breach did not occur in actual filesystem/surface state.")
