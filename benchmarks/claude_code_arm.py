#!/usr/bin/env python3
"""
Claude Code arm of the benchmark.

Deliberately kept separate and labelled: Claude Code runs a cloud frontier model
with its own prompt and cannot be pointed at the local Ollama endpoint, so it is
NOT a peer in the controlled comparison. It is a reference ceiling — "what does
this task look like when the model is not the bottleneck".

Every run bills the user's account, so trials are bounded and the running cost
is printed as it goes.
"""
import json, os, re, shutil, subprocess, sys, time
from pathlib import Path

# Configurable so this runs on any machine (matches benchmarks/harness.py).
ROOT = Path(os.environ.get("BENCH_ROOT", os.path.expanduser("~/.cache/gnomon-bench")))
WORK = Path(os.environ.get("BENCH_WORK_CC", str(ROOT.parent / "fixtures_cc")))
TIMEOUT = 300
TRIALS = int(os.environ.get("TRIALS", "2"))
DET_REPEATS = int(os.environ.get("DET_REPEATS", "3"))
BUDGET_USD = float(os.environ.get("BUDGET_USD", "6.0"))

sys.path.insert(0, str(ROOT))
from bench3 import FIXTURE, TASKS, BASELINE  # same fixture, tasks and scorers

spent = 0.0

def make_fixture(d):
    if d.exists(): shutil.rmtree(d)
    d.mkdir(parents=True)
    for rel, body in FIXTURE.items():
        p = d / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(body)
    subprocess.run(["git", "init", "-q"], cwd=d, capture_output=True)

def run_cc(prompt, d):
    t0 = time.time()
    r = subprocess.run(
        ["claude", "-p", "--output-format", "json", "--max-turns", "12",
         "--dangerously-skip-permissions", prompt],
        cwd=d, capture_output=True, text=True, timeout=TIMEOUT)
    ms = int((time.time()-t0)*1000)
    out, ti, to, calls, cost = r.stdout, None, None, None, 0.0
    try:
        j = json.loads(r.stdout)
        out = j.get("result") or j.get("output") or ""
        u = j.get("usage", {}) or {}
        # cache_read is real context the model saw; counting only input_tokens
        # would understate what this harness sends by two orders of magnitude.
        ti = (u.get("input_tokens", 0) or 0) + (u.get("cache_read_input_tokens", 0) or 0) \
             + (u.get("cache_creation_input_tokens", 0) or 0)
        to = u.get("output_tokens")
        cost = j.get("total_cost_usd", 0.0) or 0.0
        calls = max(0, (j.get("num_turns", 1) or 1) - 1)
    except Exception:
        pass
    return ms, out, ti, to, calls, cost

def main():
    global spent
    results, base, det = [], [], []

    def one(prompt, scorer, tag, task):
        global spent
        if spent >= BUDGET_USD:
            print(f"  BUDGET STOP at ${spent:.2f}", flush=True); return None
        d = WORK / tag
        make_fixture(d)
        rec = {"harness": "claude-code", "tag": tag, "task": task}
        try:
            ms, out, ti, to, calls, cost = run_cc(prompt, d)
            spent += cost
            crit = scorer(out or "", d) if scorer else {}
            rec.update(ms=ms, tokens_in=ti, tokens_out=to, tool_calls=calls, cost_usd=cost,
                       out=(out or "")[:500], criteria=crit,
                       score=sum(1 for v in crit.values() if v), max_score=len(crit),
                       ok=(all(crit.values()) if crit else None))
        except subprocess.TimeoutExpired:
            rec.update(ms=TIMEOUT*1000, tokens_in=None, tokens_out=None, tool_calls=None,
                       cost_usd=0.0, out="TIMEOUT", criteria={}, score=0, max_score=0, ok=False)
        shutil.rmtree(d, ignore_errors=True)
        print(f"  {task:9s} {rec.get('score')}/{rec.get('max_score')} "
              f"{str(rec.get('ms')):>7s}ms in={rec.get('tokens_in')} "
              f"${rec.get('cost_usd',0):.3f}  running=${spent:.2f}", flush=True)
        time.sleep(1)
        return rec

    print("== baseline ==")
    r = one(BASELINE, None, "baseline", "baseline")
    if r: base.append(r)

    print("== quality ==")
    for t in range(1, TRIALS+1):
        for tname, prompt, scorer in TASKS:
            r = one(prompt, scorer, f"{tname}-{t}", tname)
            if r: r["trial"] = t; results.append(r)

    print("== determinism (search) ==")
    tname, prompt, scorer = TASKS[0]
    for i in range(DET_REPEATS):
        r = one(prompt, scorer, f"det-{tname}-{i}", tname)
        if r: r["det"] = True; det.append(r)

    (ROOT/"results_claude_code.json").write_text(json.dumps(
        {"runs": results, "baseline": base, "determinism": det,
         "total_cost_usd": round(spent, 4)}, indent=1))
    print(f"\ntotal spend: ${spent:.2f}  -> results_claude_code.json")

if __name__ == "__main__":
    main()
