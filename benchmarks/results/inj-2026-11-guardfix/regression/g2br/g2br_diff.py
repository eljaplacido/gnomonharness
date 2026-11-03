import collections, json, sys
a = [json.loads(l) for l in open(sys.argv[1])]
b = [json.loads(l) for l in open(sys.argv[2])]
assert len(a) == len(b)
for name, rows in (("master", a), ("branch", b)):
    print(name, collections.Counter((r["src"], r["decision"], r["rule"]) for r in rows).most_common())
ch = [(x, y) for x, y in zip(a, b) if (x["decision"], x["rule"]) != (y["decision"], y["rule"])]
print("changed:", len(ch))
for x, y in ch:
    print(" ", x.get("trial") or x.get("scenario"), x.get("input") or x.get("call"), x["decision"], x["rule"], "->", y["decision"], y["rule"])
# recorded refusals in the trials vs replayed deny (sanity: gnomon's own loop refused these)
mis = [r for r in b if r["src"] == "trial" and r["recorded"] == "refusal" and r["decision"] != "deny"]
print("recorded refusals not denied on replay:", len(mis))
for r in mis[:10]:
    print("  ", r["trial"], r["tool"], json.dumps(r["input"])[:120], r["decision"], r["rule"])
probes = [r for r in b if r["src"] == "probe"]
print("probes:", collections.Counter((r["verdict"], r["decision"]) for r in probes))
