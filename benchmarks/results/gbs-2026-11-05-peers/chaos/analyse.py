#!/usr/bin/env python3
"""GBS-CHAOS 0.2 (draft): the cards of this run -> analysis.json (and a printed summary).

  python3 -I chaos/analyse.py raw/ chaos/analysis.json
Reads raw/chaos-<harness>-<seed>/<harness>-seed<seed>.json and raw/chaos-lane/endpoint-lane-check.json.
"""
import hashlib, json, math, sys
from pathlib import Path

RAW, OUT = Path(sys.argv[1]), Path(sys.argv[2])


def wilson(k, n, z=1.959964):
    if n == 0:
        return None
    p = k / n; den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [round(100 * max(0, c - h), 1), round(100 * min(1, c + h), 1)]


def volatile_free(card):
    keep = {k: v for k, v in card.items() if k not in ("endpoint", "token")}
    keep["cases"] = [{k: v for k, v in c.items() if k in ("id", "fired", "unsupported", "announced", "named", "channels", "recovered", "silent", "exit", "stop_reason")} for c in card["cases"]]
    keep.pop("baselines", None); keep.pop("lane_check", None); keep.pop("config_files", None)
    return hashlib.sha256(json.dumps(keep["cases"], sort_keys=True).encode()).hexdigest()


lane = json.loads((RAW / "chaos-lane" / "endpoint-lane-check.json").read_text())
lane_raw = (RAW / "chaos-lane" / "endpoint-lane-check.json").read_bytes()
out = {"endpoint_build_lane_check": {"harness": lane["harness"], "lane_check": lane["apparatus"]["lane_check"], "apparatus_ok": lane["apparatus"]["ok"],
                                     "sha256": hashlib.sha256(lane_raw).hexdigest(), "plan_hash": lane["plan_hash"],
                                     "in_process_summary": lane["summary"]},
       "runs": {}}
for h in ("opencode", "gnomon"):
    for seed in (1, 2):
        p = RAW / f"chaos-{h}-{seed}" / f"{h}-seed{seed}.json"
        if not p.exists():
            continue
        card = json.loads(p.read_text())
        fired = [c for c in card["cases"] if c["fired"]]
        failed = [c for c in fired if not c["recovered"]]
        base_tokens = {b["key"]: [r["prompt_tokens"] for r in b.get("endpoint_requests", [])] for b in card["baselines"]}
        rows = []
        for c in card["cases"]:
            hit = [r for r in c.get("endpoint_requests", []) if r.get("injected")]
            # opencode's first request is its session-title request: the small prompt, no tools offered
            small = min((r["prompt_tokens"] for r in c.get("endpoint_requests", [])), default=None)
            rows.append({"id": c["id"], "fired": c["fired"], "unsupported": c.get("unsupported"), "why": c.get("unsupported_why"),
                         "announced": c["announced"], "named": c["named"], "channels": c["channels"], "recovered": c["recovered"],
                         "silent": c["silent"], "exit": c["exit"], "stop_reason": c["stop_reason"], "ms": c["ms"], "requests": c["requests"],
                         "injected_prompt_tokens": [r["prompt_tokens"] for r in hit],
                         "hit_only_smallest_request": bool(hit) and all(r["prompt_tokens"] == small for r in hit) and len(c.get("endpoint_requests", [])) > 1,
                         "new_trace": c.get("new_trace", [])[:3], "billed": c["tokens"]["billed"], "leaked": c["leaked"]})
        s = card["summary"]
        out["runs"][f"{h}-seed{seed}"] = {
            "harness": card["harness"], "endpoint_build": card.get("endpoint_build"), "config_hash": card.get("config_hash"),
            "config_files": card.get("config_files"), "void": card["void"], "problems": card["problems"], "controls": card["controls"],
            "per_harness_lane_check": card["lane_check"].get("per_harness"),
            "baselines": card["baselines"], "summary": s,
            "cases_announced_of_fired": [s["cases_announced"], s["cases_fired"], wilson(s["cases_announced"], s["cases_fired"])],
            "silent_failure_share": [s["silent_failures"], s["failed"], wilson(s["silent_failures"], s["failed"])],
            "faults": card["faults"], "cases": rows, "verdict_digest": volatile_free(card)}
for h in ("opencode", "gnomon"):
    a, b = out["runs"].get(f"{h}-seed1"), out["runs"].get(f"{h}-seed2")
    if a and b:
        va = {f["id"]: f["verdict"] for f in a["faults"]}; vb = {f["id"]: f["verdict"] for f in b["faults"]}
        out[f"{h}_verdicts_same_on_seeds_1_2"] = va == vb
        out[f"{h}_verdict_changes"] = {k: [va[k], vb.get(k)] for k in va if va[k] != vb.get(k)}
OUT.write_text(json.dumps(out, indent=1) + "\n")
for k, r in out["runs"].items():
    s = r["summary"]
    print(k, "void", r["void"], r["problems"][:2], "| faults announced", s["faults_announced"], "/", s["faults"], "| cases", s["cases_announced"], "/", s["cases_fired"],
          "fired, unsupported", s.get("cases_unsupported"), "| silent failures", s["silent_failures"], "/", s["failed"], "| leaked", s["leaked"])
print("lane", out["endpoint_build_lane_check"]["lane_check"], {k: v for k, v in out.items() if k.endswith(("seeds_1_2", "changes"))})
