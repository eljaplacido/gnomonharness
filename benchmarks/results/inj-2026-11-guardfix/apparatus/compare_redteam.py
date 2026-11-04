#!/usr/bin/env python3
"""GV3 red-team, baseline vs this re-run (added for this re-run).
usage: compare_redteam.py <baseline redteam.jsonl> <re-run redteam.jsonl>
Escapes per 1k valid spellings per round, in-claim escapes, and every
spelling whose outcome changed. A variant is the same command in both runs;
validity (harm when run ungoverned) is the apparatus's own per-run reading.
"""
import json
import re
import sys

# The canary port is random per run: compare spellings with it masked.
mask = lambda c: re.sub(r"(exfil\.attacker\.test[:/ ]+)\d{2,5}|(\s)\d{4,5}(\s|$)", lambda m: (m.group(1) or m.group(2)) + "PORT" + (m.group(3) or ""), c)


def load(p):
    return [json.loads(l) for l in open(p) if l.strip()]


base, fix = load(sys.argv[1]), load(sys.argv[2])
for name, RT in (("baseline", base), ("fix", fix)):
    for rd in (1, 2):
        g = [r for r in RT if r["round"] == rd]
        v = [r for r in g if r["valid"]]
        e = [r for r in v if r["escape"]]
        ec = [r for r in e if r["claimed"]]
        print(f"{name}: round {rd}: {len(g)} variants, {len(v)} valid, {len(e)} escapes "
              f"({1000 * len(e) / max(1, len(v)):.0f} per 1k), in-claim {len(ec)}")
        for r in ec:
            print("    in-claim escape:", r["cmd"].replace("\n", "⏎")[:120])
print("\nround 1 escapes remaining in the fix (all out of claim unless marked):")
for r in fix:
    if r["round"] == 1 and r["valid"] and r["escape"]:
        print(f"  {r['seed']:12} {'CLAIMED ' if r['claimed'] else ''}{r['cmd'].replace(chr(10), '⏎')[:110]}")
bk = {(r["round"], r["seed"], mask(r["cmd"])): r for r in base}
print("\nround 1 spellings whose outcome changed (baseline -> fix):")
for r in fix:
    if r["round"] != 1:
        continue
    b = bk.get((1, r["seed"], mask(r["cmd"])))
    if b is None:
        continue
    if (b["escape"], b["ran"]) != (r["escape"], r["ran"]):
        print(f"  {r['seed']:12} escape {b['escape']}->{r['escape']} ran {b['ran']}->{r['ran']} rule {r['rule']}: {r['cmd'].replace(chr(10), '⏎')[:90]}")
