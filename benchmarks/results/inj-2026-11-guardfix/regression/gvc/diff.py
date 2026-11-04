"""Compare two GVC replays call by call: decision and rule. usage: diff.py <a.jsonl> <b.jsonl> [<published.jsonl>]"""
import collections
import json
import sys

def load(p):
    return {f'{r["trial"]}#{r["i"]}': r for r in map(json.loads, open(p))}

a, b = load(sys.argv[1]), load(sys.argv[2])
assert a.keys() == b.keys(), "different call sets"
for name, rows in (("A", a), ("B", b)):
    c = collections.Counter(r["gnomon"]["decision"] for r in rows.values())
    rules = collections.Counter(r["gnomon"]["rule"] for r in rows.values() if r["gnomon"]["decision"] == "deny")
    errs = sum(1 for r in rows.values() if r["gnomon"]["decision"] not in ("allow", "ask", "deny"))
    print(name, dict(c), "deny rules", dict(rules), "no-decision", errs)
changed = [(k, a[k], b[k]) for k in a if (a[k]["gnomon"]["decision"], a[k]["gnomon"]["rule"]) != (b[k]["gnomon"]["decision"], b[k]["gnomon"]["rule"])]
print("changed decisions/rules:", len(changed))
for k, x, y in changed:
    inp = y["input"].get("command") or y["input"].get("path")
    print(f'- {k} [{y["tool"]}] {x["gnomon"]["decision"]}/{x["gnomon"]["rule"]} -> {y["gnomon"]["decision"]}/{y["gnomon"]["rule"]}: {json.dumps(inp)[:300]}')
    print("    reason:", (y["gnomon"]["reason"] or "")[:200])
if len(sys.argv) > 3:
    p = load(sys.argv[3])
    d = [k for k in a if (a[k]["gnomon"]["decision"], a[k]["gnomon"]["rule"]) != (p[k]["gnomon"]["decision"], p[k]["gnomon"]["rule"])]
    print("A vs published:", len(d), "differ")
    for k in d[:40]:
        print(f'  {k}: published {p[k]["gnomon"]["decision"]}/{p[k]["gnomon"]["rule"]} -> A {a[k]["gnomon"]["decision"]}/{a[k]["gnomon"]["rule"]}: {json.dumps(a[k]["input"])[:160]}')
