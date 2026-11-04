"""C2D stage 1: write each cell's cell.json after the fact (addendum 1, ../PRE-REGISTRATION.md).

run_c2d.py called run_p2g.trial_of, which assumes results live under p2g-2026-11/, so every cell
raised after Harbor returned: the log relay was stopped (its finally block ran) and Harbor's job
files and the wire logs are complete, but cell.json was never written and the wave's spend was
booked as $0. This rebuilds cell.json from the same sources the runner would have used:
Harbor's trial result.json (reward, exception, agent version, timing) and the wire log's per-call
usage (the provider's own allowance figure per reply; the slot-relay counter deltas were never
taken). Nothing here contacts a model or a relay.

  python3 finalize_c2d.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS, JOBS = ROOT / "runs", ROOT / "jobs"


def trial(cid: str) -> dict | None:
    for r in sorted((JOBS / cid).rglob("result.json")):
        j = json.loads(r.read_text(encoding="utf-8"))
        if "verifier_result" in j or "agent_info" in j:
            return {"path": str(r.relative_to(ROOT)), "reward": (j.get("verifier_result") or {}).get("rewards"),
                    "exception": (j.get("exception_info") or {}).get("exception_type"),
                    "agent_version": (j.get("agent_info") or {}).get("version"),
                    "timing": {k: j.get(k) for k in ("environment_setup", "agent_setup", "agent_execution", "verifier")
                               if isinstance(j.get(k), dict)}}
    return None


def main() -> None:
    total = 0.0
    for d in sorted(RUNS.glob("c2d-k1-*")):
        cid = d.name
        calls = [json.loads(l) for l in (d / "wire" / "calls.jsonl").read_text().splitlines() if l.strip()]
        usage = [((c.get("resp") or {}).get("usage") or {}) for c in calls]
        spend = sum((u.get("opencode") or {}).get("allowance") or 0 for u in usage)
        rec = {"cell": cid, "written_by": "finalize_c2d.py (addendum 1)", "trial": trial(cid),
               "wire": {"calls": len(calls), "status_200": sum(c.get("status") == 200 for c in calls),
                        "aborted": sum(bool(c.get("aborted")) for c in calls),
                        "completion_tokens": sum(u.get("completion_tokens") or 0 for u in usage),
                        "prompt_tokens": sum(u.get("prompt_tokens") or 0 for u in usage),
                        "allowance_usd": round(spend, 6)}}
        (d / "cell.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")
        total += spend
        t = rec["trial"] or {}
        print(f"{cid}: reward={t.get('reward')} exc={t.get('exception')} calls={len(calls)} spend=${spend:.4f}")
    print(f"stage 1 spend (wire): ${total:.4f}")


if __name__ == "__main__":
    main()
