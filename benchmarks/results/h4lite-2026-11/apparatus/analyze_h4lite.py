"""H4-lite analysis, exactly as ../PRE-REGISTRATION.md "Analysis" states it. Reads runs/<cell>/cell.json and the
Harbor trial dirs under jobs/; writes ../cells-h4lite.csv and prints the summary (saved as ../summary-h4lite.txt).

  python3 analyze_h4lite.py
"""
import csv
import json
import random
import statistics
import sys
from collections import Counter
from math import comb
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from run_h4lite import B41_FRAC, CONTROLS, TASKS  # noqa: E402

CAP_S = 1800
SEED, B = 20261105, 10000


def jload(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def trial_dir(cid: str) -> Path | None:
    for r in sorted((ROOT / "jobs" / cid).glob("*/result.json")):
        return r.parent
    return None


def secs(t: dict | None) -> float | None:
    if not t or not t.get("started_at") or not t.get("finished_at"):
        return None
    from datetime import datetime
    f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))  # noqa: E731
    return (f(t["finished_at"]) - f(t["started_at"])).total_seconds()


def gate_of(agent: Path) -> dict:
    task = jload(agent / "gnomon-task.json")

    def find(o):
        if isinstance(o, dict):
            if isinstance(o.get("completion_gate"), dict):
                return o["completion_gate"]
            for v in o.values():
                r = find(v)
                if r is not None:
                    return r
        elif isinstance(o, list):
            for v in o:
                r = find(v)
                if r is not None:
                    return r
        return None

    cg = find(task) if task else None
    cg_src = "record" if cg else None
    if cg is None:  # a capped cell: the adapter's 20 s live copy of the partial record
        for f in sorted((agent / "audit-live").glob("*.record.json")) if (agent / "audit-live").exists() else []:
            cg = find(jload(f))
            if cg is not None:
                cg_src = "live-record"
                break
    recs, src = [], None
    for sub in ("audit", "audit-live"):
        d = agent / sub
        if not d.exists():
            continue
        rs = []
        for f in sorted(d.rglob("*")):
            if f.is_file():
                for line in f.read_text(errors="replace").splitlines():
                    if '"completion_gate"' in line:
                        try:
                            r = json.loads(line)
                        except Exception:
                            continue
                        if r.get("kind") == "completion_gate":
                            rs.append(r)
        if rs or sub == "audit":
            recs, src = rs, sub
            if rs:
                break
    out = {"gate_src": cg_src if cg else (f"trail-{src}" if recs else "none"), "gate_actions": ">".join(
        f"{r.get('action')}" + (f"({r.get('findings')})" if r.get("action") == "review" else "") for r in recs)}
    if cg:
        out.update({f"gate_{k}": cg.get(k) for k in ("mode", "rounds", "checks", "reviews", "review_steps", "findings", "outcome")})
    elif recs:
        acts = [r.get("action") for r in recs]
        out.update({"gate_mode": "review?", "gate_rounds": max((r.get("round") or 0) for r in recs) if any(a != "accept" for a in acts) else 0,
                    "gate_reviews": acts.count("review"), "gate_findings": sum(r.get("findings") or 0 for r in recs if r.get("action") == "review"),
                    "gate_outcome": next((r.get("outcome") for r in recs if r.get("action") == "accept"), "unfinished")})
    out.update(trail_calls(agent, recs))
    return out


def trail_calls(agent: Path, recs: list[dict]) -> dict:
    """Addendum 1 (descriptive, added after wave 1): the reviewer's own model calls carry `depth: 1` in the audit
    trail, and gate-steered main calls `via: "system"`. Counted from the final trail (audit/), else the live copy
    (audit-live/, up to 20 s stale, the only trail a capped cell leaves)."""
    for sub in ("audit", "audit-live"):
        fs = sorted((agent / sub).glob("*.jsonl")) if (agent / sub).exists() else []
        if fs:
            break
    else:
        return {}
    ev = []
    for f in fs:
        for line in f.read_text(errors="replace").splitlines():
            try:
                ev.append(json.loads(line))
            except Exception:
                pass
    mc = [e for e in ev if e.get("kind") == "model_call"]
    rev = [e for e in mc if (e.get("depth") or 0) >= 1]
    first_gate = min((r.get("ts") for r in recs if r.get("ts")), default=None)
    after = [e for e in mc if first_gate and e.get("ts", "") > first_gate]
    return {"t_main_calls": len(mc) - len(rev), "t_review_calls": len(rev),
            "t_review_model_s": round(sum(e.get("ms") or 0 for e in rev) / 1000, 1),
            "t_steered_calls": sum(1 for e in mc if e.get("via") == "system"),
            "t_calls_after_gate": len(after),
            "t_review_at_end": bool(mc and (mc[-1].get("depth") or 0) >= 1)}


def cell_row(arm: str, task: str) -> dict | None:
    cid = f"h4l-k1-{arm}-{task}"
    c = jload(ROOT / "runs" / cid / "cell.json")
    if not c:
        return None
    td = trial_dir(cid)
    res = jload(td / "result.json") if td else None
    tr = c.get("trial") or {}
    reward = ((tr.get("reward") or {}) or {}).get("reward") if isinstance(tr.get("reward"), dict) else None
    ctrf = jload(td / "verifier" / "ctrf.json") if td else None
    s = ((ctrf or {}).get("results") or {}).get("summary") or {}
    tests, passed = s.get("tests"), s.get("passed")
    frac = (passed / tests) if tests else (float(reward) if reward is not None else None)
    exec_s = secs((res or {}).get("agent_execution"))
    d = c.get("delta") or {}
    valid = reward is not None and (d.get("responses_with_usage") or 0) > 0
    capped = tr.get("exception") == "AgentTimeoutError"
    solved = bool(reward is not None and reward >= 1)
    agent = td / "agent" if td else None
    row = {"cell": cid, "arm": arm, "task": task, "control": task in CONTROLS, "b41_frac": B41_FRAC[task], "slot": c.get("slot"),
           "started": c.get("started"), "valid": valid, "reward": reward, "tests": tests, "passed": passed,
           "frac": None if frac is None else round(frac, 4), "solved": solved, "capped": capped,
           "exception": tr.get("exception"), "exec_s": None if exec_s is None else round(exec_s, 1),
           "false_finish": bool(valid and not capped and not solved and exec_s is not None and exec_s <= CAP_S - 300),
           "requests": d.get("chat_requests"), "with_usage": d.get("responses_with_usage"), "s5xx": d.get("status_5xx"),
           "prompt": d.get("prompt_tokens"), "completion": d.get("completion_tokens"), "allowance": d.get("allowance"),
           "wire_usd": c.get("wire_spend_usd"), "load_start": round(c["load"]["start"][0], 1), "load_end": round(c["load"]["end"][0], 1),
           "containers_start": (c.get("containers") or {}).get("start"), "containers_end": (c.get("containers") or {}).get("end"),
           "version": tr.get("agent_version"),
           "release": (agent / "gnomon-release.txt").read_text().strip() if agent and (agent / "gnomon-release.txt").exists() else None,
           "gnomon_exit": (agent / "gnomon-exit.txt").read_text().strip() if agent and (agent / "gnomon-exit.txt").exists() else None,
           "patch_failed": bool(agent and any(agent.glob("*patch-failed.txt")))}
    pol = (agent / "surface-policy.toml").read_text() if agent and (agent / "surface-policy.toml").exists() else ""
    row["policy_gate_line"] = 'completion_gate = "review"' in pol
    row.update(gate_of(agent) if agent and agent.exists() else {"gate_src": "none"})
    return row


def boot_ci(diffs: list[float]) -> tuple[float, float]:
    rng = random.Random(SEED)
    n = len(diffs)
    ms = sorted(sum(rng.choice(diffs) for _ in range(n)) / n for _ in range(B))
    return ms[int(0.025 * B)], ms[int(0.975 * B) - 1]


def mcnemar(b: int, c: int) -> float:
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    return min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)


def main() -> int:
    rows = [r for t in TASKS for a in ("C", "G") if (r := cell_row(a, t))]
    if not rows:
        print("no cells yet")
        return 1
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with open(ROOT / "cells-h4lite.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
    by = {(r["arm"], r["task"]): r for r in rows}
    L = []
    p = L.append
    p("H4-lite summary (exploratory screen; pre-registered analysis, ../PRE-REGISTRATION.md)")
    p(f"cells run: {len(rows)}  (C {sum(r['arm'] == 'C' for r in rows)}, G {sum(r['arm'] == 'G' for r in rows)})")
    inval = [r for r in rows if not r["valid"]]
    p(f"buckets: valid {len(rows) - len(inval)} + invalid {len(inval)} = {len(rows)}"
      + "".join(f"\n  invalid {r['cell']}: exc={r['exception']} reward={r['reward']} with_usage={r['with_usage']} 5xx={r['s5xx']} patch_failed={r['patch_failed']}" for r in inval))
    assert len(rows) - len(inval) + len(inval) == len(rows)
    builds = sorted({r["release"] for r in rows if r["release"]})
    p(f"build per cell (gnomon-release.txt): {builds}")
    p(f"G cells with the gate line in policy.toml: {sum(r['policy_gate_line'] for r in rows if r['arm'] == 'G')}/{sum(r['arm'] == 'G' for r in rows)}; "
      f"C cells with it: {sum(r['policy_gate_line'] for r in rows if r['arm'] == 'C')}")
    p("")
    p("per task (C | G): frac, solved, capped, false-finish, exec_s, requests, $; G gate")
    for t in TASKS:
        c, g = by.get(("C", t)), by.get(("G", t))
        if not c and not g:
            continue
        f = lambda r: "—" if not r else (f"{r['frac']} {'S' if r['solved'] else '-'} {'CAP' if r['capped'] else ''}{'FF' if r['false_finish'] else ''}"  # noqa: E731
                                          f" {r['exec_s']}s {r['requests']}req ${r['wire_usd']}{'' if r['valid'] else ' INVALID'}")
        gate = "" if not g else f"gate[{g.get('gate_src')}: rounds={g.get('gate_rounds')} checks={g.get('gate_checks')} reviews={g.get('gate_reviews')} " \
                                f"review_steps={g.get('gate_review_steps')} findings={g.get('gate_findings')} outcome={g.get('gate_outcome')}; {g.get('gate_actions')}; " \
                                f"trail: reviewer calls {g.get('t_review_calls')} ({g.get('t_review_model_s')} s model), steered main calls {g.get('t_steered_calls')}" \
                                f"{', CAPPED WHILE THE REVIEWER RAN' if g['capped'] and g.get('t_review_at_end') else ''}]"
        p(f"  {t}{' (control)' if t in CONTROLS else ''} B41={B41_FRAC[t]}:  C {f(c)} | G {f(g)}  {gate}")
    p("")

    def paired(tasks, label):
        pr = [(by[("C", t)], by[("G", t)]) for t in tasks if ("C", t) in by and ("G", t) in by
              and by[("C", t)]["valid"] and by[("G", t)]["valid"] and by[("C", t)]["frac"] is not None and by[("G", t)]["frac"] is not None]
        if not pr:
            p(f"{label}: no valid pairs")
            return None
        d = [g["frac"] - c["frac"] for c, g in pr]
        lo, hi = boot_ci(d) if len(d) > 1 else (float("nan"), float("nan"))
        p(f"{label}: n={len(pr)} valid pairs; mean C frac {statistics.mean(c['frac'] for c, _ in pr):.3f}, G {statistics.mean(g['frac'] for _, g in pr):.3f}; "
          f"paired G-C {statistics.mean(d):+.3f} [95% task-bootstrap {lo:+.3f}, {hi:+.3f}]")
        sc, sg = sum(c["solved"] for c, _ in pr), sum(g["solved"] for _, g in pr)
        b = sum(g["solved"] and not c["solved"] for c, g in pr)
        cc = sum(c["solved"] and not g["solved"] for c, g in pr)
        p(f"  solved C {sc}, G {sg}; discordant G-only {b}, C-only {cc}; exact McNemar p = {mcnemar(b, cc):.3f}")
        p(f"  capped C {sum(c['capped'] for c, _ in pr)}, G {sum(g['capped'] for _, g in pr)}; "
          f"false finish C {sum(c['false_finish'] for c, _ in pr)}, G {sum(g['false_finish'] for _, g in pr)}")
        ec = [c["exec_s"] for c, _ in pr if c["exec_s"] is not None]
        eg = [g["exec_s"] for _, g in pr if g["exec_s"] is not None]
        dw = [g["exec_s"] - c["exec_s"] for c, g in pr if c["exec_s"] is not None and g["exec_s"] is not None]
        p(f"  wall (agent_execution) median C {statistics.median(ec):.0f}s, G {statistics.median(eg):.0f}s; paired G-C mean {statistics.mean(dw):+.0f}s")
        p(f"  requests C {sum(c['requests'] or 0 for c, _ in pr)}, G {sum(g['requests'] or 0 for _, g in pr)}; "
          f"prompt tokens C {sum(c['prompt'] or 0 for c, _ in pr):,}, G {sum(g['prompt'] or 0 for _, g in pr):,}; "
          f"wire $ C {sum(c['wire_usd'] or 0 for c, _ in pr):.4f}, G {sum(g['wire_usd'] or 0 for _, g in pr):.4f}")
        return {"mean": statistics.mean(d), "lo": lo, "hi": hi, "pairs": pr}

    targets = [t for t in TASKS if t not in CONTROLS]
    prim = paired(targets, "PRIMARY (targets)")
    p("")
    paired(list(TASKS), "SENSITIVITY (all 14 incl. controls)")
    p("")
    p("controls (harm check):")
    harm = False
    for t in CONTROLS:
        c, g = by.get(("C", t)), by.get(("G", t))
        if c and g:
            h = (c["solved"] and not g["solved"]) or (g["capped"] and not c["capped"])
            harm = harm or (h and c["valid"] and g["valid"])
            p(f"  {t}: C frac {c['frac']} solved={c['solved']} capped={c['capped']} | G frac {g['frac']} solved={g['solved']} capped={g['capped']}"
              f"  -> {'HARM' if h else 'no harm'}")
    gs = [r for r in rows if r["arm"] == "G" and r["valid"]]
    acted = [r for r in gs if (r.get("gate_rounds") or 0) > 0]
    p("")
    p(f"gate (G, valid cells): acted in {len(acted)}/{len(gs)}; rounds {sum(r.get('gate_rounds') or 0 for r in gs)}, "
      f"checks {sum(r.get('gate_checks') or 0 for r in gs)}, reviews {sum(r.get('gate_reviews') or 0 for r in gs)}, "
      f"review steps {sum(r.get('gate_review_steps') or 0 for r in gs)}, findings {sum(r.get('gate_findings') or 0 for r in gs)}; "
      f"outcomes {dict(sorted(Counter(str(r.get('gate_outcome')) for r in gs).items()))}")
    p(f"  (addendum 1, descriptive) reviewer model calls {sum(r.get('t_review_calls') or 0 for r in gs)}, reviewer model time "
      f"{sum(r.get('t_review_model_s') or 0 for r in gs):.0f} s; G cells with a reviewer sub-turn {sum((r.get('t_review_calls') or 0) > 0 for r in gs)}; "
      f"G cells capped while the reviewer ran {sum(bool(r['capped'] and r.get('t_review_at_end')) for r in gs)}; "
      f"C cells capped {sum(r['capped'] for r in rows if r['arm'] == 'C' and r['valid'])}")
    cneg = [r for r in rows if r["arm"] == "C" and (r.get("gate_src") not in (None, "none") or (r.get("t_review_calls") or 0) > 0)]
    p(f"negative control: C cells with any gate counters/records: {len(cneg)}")
    p(f"spend (wire): C ${sum(r['wire_usd'] or 0 for r in rows if r['arm'] == 'C'):.4f}, G ${sum(r['wire_usd'] or 0 for r in rows if r['arm'] == 'G'):.4f}, "
      f"total ${sum(r['wire_usd'] or 0 for r in rows):.4f}")
    nc = [r["containers_start"] for r in rows if r["containers_start"] is not None]
    p(f"host load (1-min) at cell start: median {statistics.median(r['load_start'] for r in rows):.1f}, max {max(r['load_start'] for r in rows):.1f}; "
      f"running containers at start: median {statistics.median(nc) if nc else 'n/a'}, max {max(nc) if nc else 'n/a'}")
    if prim:
        tp = [x for x in prim["pairs"]]
        capC, capG = sum(c["capped"] for c, _ in tp), sum(g["capped"] for _, g in tp)
        pos = prim["mean"] > 0 and not harm and capG <= capC + 1
        verdict = ("POSITIVE SIGNAL" + (", interval excludes 0" if prim["lo"] > 0 else "")) if pos else "NO POSITIVE SIGNAL"
        p("")
        p(f"SCREEN DECISION (pre-registered): {verdict}  (primary mean {prim['mean']:+.3f}, control harm={harm}, capped targets C {capC} / G {capG})")
    out = "\n".join(L)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
