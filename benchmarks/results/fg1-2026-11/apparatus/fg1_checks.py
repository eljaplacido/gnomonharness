"""FG1 mechanism checks beyond the fragments' [[expect]] lines (PRE-REGISTRATION §6). Pure functions over a cell's
/logs/agent copy (agent_dir) and its wire directory (calls.jsonl from log-relay.mjs, or the wire test's fake-model
equivalent in the same format). Used by run_fg1.py (scoring) and wiretest_fg1.py (pre-launch), so the wire test
proves exactly the checks the cells are scored with.

Per cell (severity fatal unless noted; 'unverifiable' is never a failure):
  key        every chat request reached the relay carrying the cell's placeholder key (auth == "placeholder"):
             the v0.4.5+ key grant held (an untrusted surface would run clamped and drop api_key_env -> "absent")
  trust      the trust grant ran and named the bench endpoint's key grant (fg1-trust-grant.txt), and no audit `trust`
             record of the cell says "clamped"
  job_tool   C, FG: no request offers a `job` tool; SH: every request does
  job_audit  C, FG: no audit record of kind `job`; SH: no bash call in the record ran past yield + 5 s (a command
             past the yield must come back as a job, not block) -- and the count of `yield` events is reported
  gate_audit C, SH: no audit record of kind `finish_gate`; FG: reported (fires / accepts)
  replay     a request after a reasoned tool reply carries reasoning back (assistant_with_reasoning > 0)
Per arm (run_fg1.py report): FG fires on >= 80% of applicable records; SH yields at least once in the run.
"""
from __future__ import annotations

import json
from pathlib import Path

YIELD_S = 30
GATE_FIRE_MIN = 0.80


def calls(wire_dir: Path | None) -> list[dict]:
    f = Path(wire_dir) / "calls.jsonl" if wire_dir else None
    if not f or not f.exists():
        return []
    out = []
    for l in f.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(l)
        except Exception:
            continue
        if isinstance(r.get("req"), dict) and "tools" in r["req"]:
            out.append(r)
    return sorted(out, key=lambda r: r.get("n", 0))


def audit_records(agent_dir: Path | None) -> list[dict]:
    if agent_dir is None:
        return []
    out = []
    for sub in ("audit", "audit-live"):
        files = sorted((Path(agent_dir) / sub).glob("*.jsonl")) if (Path(agent_dir) / sub).is_dir() else []
        for f in files:
            for l in f.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    out.append(json.loads(l))
                except Exception:
                    pass
        if files:
            break  # the final trail when it exists, else the live copy
    return out


def record(agent_dir: Path | None) -> dict | None:
    p = Path(agent_dir) / "gnomon-task.json" if agent_dir else None
    if p is None or not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _r(check, result, detail="", severity="fatal"):
    return {"check": check, "result": result, "severity": severity, "detail": detail}


def cell_checks(arm: str, agent_dir: Path | None, wire_dir: Path | None, yield_s: int = YIELD_S) -> list[dict]:
    rows = calls(wire_dir)
    aud = audit_records(agent_dir)
    rec = record(agent_dir)
    out = []
    # key
    if rows:
        bad = [r.get("auth") for r in rows if r.get("auth") != "placeholder"]
        out.append(_r("key", "fail" if bad else "pass", f"{len(rows) - len(bad)}/{len(rows)} requests carried the key"
                      + (f"; others: {sorted(set(map(str, bad)))}" if bad else "")))
    else:
        out.append(_r("key", "unverifiable", "no requests"))
    # trust
    g = Path(agent_dir) / "fg1-trust-grant.txt" if agent_dir else None
    if g is not None and g.exists():
        t = g.read_text(encoding="utf-8", errors="replace")
        clamped = [x for x in aud if x.get("kind") == "trust" and x.get("decision") == "clamped"]
        ok = "Trusted" in t and "OPENAI_API_KEY" in t and not clamped
        out.append(_r("trust", "pass" if ok else "fail", (t.strip().splitlines()[0][:120] if t.strip() else "empty")
                      + f"; audit trust decisions {sorted({str(x.get('decision')) for x in aud if x.get('kind') == 'trust'})}"))
    else:
        out.append(_r("trust", "unverifiable", "no fg1-trust-grant.txt"))
    # job tool on the wire
    if rows:
        offered = [("job" in (r["req"].get("tools") or [])) for r in rows]
        if arm == "SH":
            out.append(_r("job_tool", "pass" if all(offered) else "fail", f"job offered in {sum(offered)}/{len(rows)}"))
        else:
            out.append(_r("job_tool", "fail" if any(offered) else "pass", f"job offered in {sum(offered)}/{len(rows)}"))
    else:
        out.append(_r("job_tool", "unverifiable", "no requests"))
    # job audit
    jobs = [a for a in aud if a.get("kind") == "job"]
    yields = sum(1 for a in jobs if a.get("event") == "yield")
    if arm == "SH":
        long = []
        if rec is not None:
            long = [t.get("duration_ms") for t in (rec.get("volatile") or {}).get("tool_calls", [])
                    if t.get("tool") == "bash" and (t.get("duration_ms") or 0) > (yield_s + 5) * 1000]
        res = "fail" if long else ("pass" if rec is not None else "unverifiable")
        out.append(_r("job_audit", res, f"{yields} yield(s), {len(jobs)} job record(s); bash calls past yield+5 s: {long}"))
    else:
        out.append(_r("job_audit", "fail" if jobs else ("pass" if aud else "unverifiable"), f"{len(jobs)} job record(s)"))
    # finish gate audit
    fg = [a for a in aud if a.get("kind") == "finish_gate"]
    fires = sum(1 for a in fg if a.get("action") == "fire")
    if arm == "FG":
        out.append(_r("gate_audit", "pass" if aud else "unverifiable",
                      f"{len(fg)} finish_gate record(s), {fires} fire(s)", severity="warn"))
    else:
        out.append(_r("gate_audit", "fail" if fg else ("pass" if aud else "unverifiable"), f"{len(fg)} finish_gate record(s)"))
    # replay
    first = next((i for i, r in enumerate(rows) if ((r.get("resp") or {}).get("reasoning_chars") or 0) > 0
                  and (r.get("resp") or {}).get("tool_calls")), None)
    later = rows[first + 1:] if first is not None else []
    if later:
        carried = max((r["req"].get("assistant_with_reasoning") or 0) for r in later)
        out.append(_r("replay", "pass" if carried > 0 else "fail", f"max assistant_with_reasoning after the first "
                      f"reasoned tool reply = {carried}"))
    else:
        out.append(_r("replay", "unverifiable", "no request after a reasoned tool reply"))
    return out


def failed(results: list[dict]) -> list[dict]:
    return [r for r in results if r["result"] == "fail" and r["severity"] == "fatal"]


def gate_stats(rec: dict | None) -> dict | None:
    """FG: applicable = a final record whose finish_gate outcome is passed/exhausted/skipped_budget; fired = rounds>=1."""
    if not rec:
        return None
    fgc = (rec.get("counters") or {}).get("finish_gate")
    if not isinstance(fgc, dict):
        return None
    out = fgc.get("outcome")
    return {"outcome": out, "rounds": fgc.get("rounds", 0), "applicable": out in ("passed", "exhausted", "skipped_budget"),
            "fired": (fgc.get("rounds") or 0) >= 1, "caveats": fgc.get("caveats"), "caveats_final": fgc.get("caveats_final")}
