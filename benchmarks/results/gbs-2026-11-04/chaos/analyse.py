#!/usr/bin/env python3
"""GBS-CHAOS 0.1 analysis for gnomon v0.4.1: reads raw/ cards, writes analysis.json."""
import json, math, sys, os, hashlib
here = os.path.dirname(os.path.abspath(__file__)); raw = os.path.join(here, "raw")
def wilson(k, n, z=1.959964):
    if n == 0: return None
    p = k / n; d = 1 + z*z/n; c = (p + z*z/(2*n)) / d; h = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / d
    return [round(max(0, c-h), 4), round(min(1, c+h), 4)]
def load(n): return json.load(open(os.path.join(raw, n)))
cards = {r: load(f"card-seed{r}.json") for r in ["1a","1b","2","3","4","5","6","7","8","9","10"]}
strip = lambda c: json.dumps({k: v for k, v in c.items() if k != "volatile"}, sort_keys=True)
p = cards["1a"]; s = p["summary"]
out = {
 "primary_seed1": {
   "harness": p["harness"], "plan_hash": p["plan_hash"], "surface_template_hash": p["surface_template_hash"],
   "void": not p["apparatus"]["ok"], "problems": p["apparatus"]["problems"], "controls_held": f'{sum(c["ok"] for c in p["controls"])}/{len(p["controls"])}',
   "lane_check": p["apparatus"]["lane_check"], "clean_runs_finished": f'{sum(b["recovered"] for b in p["apparatus"]["baselines"])}/{len(p["apparatus"]["baselines"])}',
   "faults_announced": f'{s["faults_announced"]}/{s["faults"]}', "faults_silent": s["faults_silent"],
   "cases_fired": f'{s["cases_fired"]}/{s["cases"]}',
   "cases_announced": {"k": s["cases_announced"], "n": s["cases_fired"], "wilson95": wilson(s["cases_announced"], s["cases_fired"])},
   "cases_named": {"k": s["cases_named"], "n": s["cases_fired"], "wilson95": wilson(s["cases_named"], s["cases_fired"])},
   "cases_recovered": {"k": s["cases_recovered"], "n": s["cases_fired"], "wilson95": wilson(s["cases_recovered"], s["cases_fired"])},
   "silent_failure_share": {"k": s["silent_failures"], "n": s["failed"], "wilson95": wilson(s["silent_failures"], s["failed"])},
   "tokens_wasted_billed": s["tokens_wasted"], "tokens_counted_by_record": sum(c["tokens"]["counted"] for c in p["cases"]),
   "leaked": sum(c["leaked"] for c in p["cases"]), "exit": p["exit"],
 },
 "determinism_seed1_twice": {"equal_outside_volatile": strip(cards["1a"]) == strip(cards["1b"]),
   "sha256_outside_volatile": [hashlib.sha256(strip(cards[r]).encode()).hexdigest() for r in ["1a","1b"]]},
}
# seed stability
verd = {}
for r, c in cards.items():
    if r == "1b": continue
    for f in c["faults"]: verd.setdefault(f["id"], {})[r] = f["verdict"]
out["seeds_1_to_10"] = {
  "void_runs": [r for r, c in cards.items() if not c["apparatus"]["ok"]],
  "faults_announced_per_seed": {r: c["summary"]["faults_announced"] for r, c in cards.items() if r != "1b"},
  "cases_announced_per_seed": {r: f'{c["summary"]["cases_announced"]}/{c["summary"]["cases_fired"]}' for r, c in cards.items() if r != "1b"},
  "seed_unstable_faults": {f: v for f, v in verd.items() if len(set(v.values())) > 1},
  "pooled_cases_announced_LABEL_pooled_over_seeds_not_independent": (lambda k, n: {"k": k, "n": n, "wilson95": wilson(k, n)})(
      sum(c["summary"]["cases_announced"] for r, c in cards.items() if r != "1b"), sum(c["summary"]["cases_fired"] for r, c in cards.items() if r != "1b")),
  "pooled_silent_failure_share": (lambda k, n: {"k": k, "n": n, "wilson95": wilson(k, n)})(
      sum(c["summary"]["silent_failures"] for r, c in cards.items() if r != "1b"), sum(c["summary"]["failed"] for r, c in cards.items() if r != "1b")),
}
# arm B vs R seed 1
b = load("blackbox-seed1.json"); rc = {c["id"]: c for c in p["cases"]}
dis = []
for c in b["cases"]:
    r = rc[c["id"]]
    for k in ["fired", "announced", "named", "recovered"]:
        if c[k] != r[k]: dis.append({"case": c["id"], "field": k, "in_process": r[k], "black_box": c[k], "in_process_channels": r["channels"], "black_box_channels": c["channels"]})
chan = [{"case": c["id"], "in_process": rc[c["id"]]["channels"], "black_box": c["channels"]} for c in b["cases"] if c["channels"] != rc[c["id"]]["channels"]]
out["arm_B_vs_R_seed1"] = {"B_void": b["void"], "B_problems": b["problems"], "B_summary": b["summary"], "B_controls": b["controls"], "B_lane_check": b["lane_check"],
  "B_baselines": b["baselines"], "disagreements_on_verdicts": dis, "channel_set_differences": chan}
json.dump(out, open(os.path.join(here, "analysis.json"), "w"), indent=2)
print(json.dumps(out, indent=1)[:6000])
