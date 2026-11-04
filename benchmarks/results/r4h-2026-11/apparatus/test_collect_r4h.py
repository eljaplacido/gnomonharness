"""Offline tests of collect_r4h.py (writes only a temp dir it removes):
- the smoke gate on REAL cells: R1H's own PC smoke cell (d59e6c19) as OLD, R3R's PC and NEG smoke cells (v0.4.0) as
  NEW with the commit relabelled to v0.4.1 (whose surface and wire are v0.4.0's: wiretest-r4h.txt), each given the
  meter timeline R4H's runner writes (synthesised from the cell's own tokens.json) and, for OLD, the counts
  relay-meter-s1 records for an unstreamed request without max_tokens (stream 0, max_tokens 0, as the wire test shows);
  it must PASS, and each single defect must FAIL it;
- the timeline reconstruction (FIFO pairing, overlap, calls open at the end, output per call);
- the paired decision rule on synthetic pairs, at and around p = 0.05.
    python3 -I -B test_collect_r4h.py   (exit 0 when all pass)
"""
import io
import json
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_r4h as K  # noqa: E402

RES = HERE.parent.parent
SRC = {"old": RES / "r1h-2026-11" / "runs-smoke" / "r1h-s-pc-hello-world",
       "new": RES / "r3r-2026-11" / "runs-smoke" / "r3r-s-pc-hello-world",
       "neg": RES / "r3r-2026-11" / "runs-smoke" / "r3r-s-neg-hello-world"}
PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    PASS, FAIL = (PASS + 1, FAIL) if cond else (PASS, FAIL + 1)
    print(f"{'ok  ' if cond else 'FAIL'}  {what}")


def smoke(d: Path) -> tuple[int, str]:
    K.SMOKE_DIR = d
    buf = io.StringIO()
    with redirect_stdout(buf):
        try:
            K.smoke()
            code = 0
        except SystemExit as e:
            code = e.code
    return code, buf.getvalue()


def synth_timeline(tok: dict, t0: float = 1000.0) -> dict:
    """One sample per cloud request: arrival, then end, from the cell's own before/after counters."""
    b, a = tok["cloud"]["before"], tok["cloud"]["after"]
    n = a.get("chat_requests", 0) - b.get("chat_requests", 0)
    out = (a.get("completion_tokens", 0) - b.get("completion_tokens", 0)) / max(n, 1)
    keep = lambda c: {k: c.get(k, 0) for k in K.END_KEYS + ("chat_requests", "completion_tokens")}
    cur, samples, t = keep(b), [], t0
    for _ in range(n):
        cur = {**cur, "chat_requests": cur["chat_requests"] + 1}
        t += 1
        samples.append({"t": t, "c": dict(cur), "l": {}})
        cur = {**cur, "responses_with_usage": cur["responses_with_usage"] + 1, "completion_tokens": cur["completion_tokens"] + out}
        t += 5
        samples.append({"t": t, "c": dict(cur), "l": {}})
    return {"start": t0, "before": {"c": keep(b), "l": {}}, "poll_s": 1.0, "polls": max(len(samples), 1), "errors": 0, "samples": samples}


def fresh(T: Path, skip: set = frozenset()) -> Path:
    d = T / "runs-smoke"
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    for tag, src in SRC.items():
        cell = d / f"r4h-s-{tag}-hello-world"
        shutil.copytree(src, cell)
        build = "OLD" if tag == "old" else "NEW"
        meta = json.loads((cell / "cell.json").read_text())
        meta["sha"] = K.SHA[build]
        (cell / "cell.json").write_text(json.dumps(meta))
        logs = next(cell.glob("*/*/agent-logs"))
        if tag != "old" and "commit" not in skip:
            (logs / "gnomon-commit.txt").write_text(K.SHA["NEW"] + "\nHEAD\n")
        t = json.loads((cell / "tokens.json").read_text())
        if tag == "old":
            for side in ("before", "after"):
                t["local"][side].update(req_stream=0, req_max_tokens=0)
            if "oldstream" in skip:
                n = t["local"]["after"]["chat_requests"] - t["local"]["before"]["chat_requests"]
                t["local"]["after"]["req_stream"] = n
            (cell / "tokens.json").write_text(json.dumps(t))
        if "surface" in skip and tag == "old":
            s = (logs / "surface-config.toml").read_text()
            (logs / "surface-config.toml").write_text(s.replace("max_context_tokens = 65536", "max_context_tokens = 65536\nstream = true\nmax_tokens = 32768", 1))
        if not ("timeline" in skip and tag == "new"):
            (cell / "timeline.json").write_text(json.dumps(synth_timeline(t)))
    return d


missing = [str(p) for p in SRC.values() if not p.is_dir()]
if missing:
    sys.exit(f"not found: {missing}")
T = Path(tempfile.mkdtemp(prefix="r4h-collect-test-"))
try:
    code, out = smoke(fresh(T))
    check(code == 0 and out.rstrip().endswith("smoke: PASS"), "R1H's real PC smoke cell as OLD and R3R's real PC/NEG smoke cells as NEW (relabelled v0.4.1) pass")
    check("r4h-s-neg-hello-world      misrouted" in out and "r4h-s-old-hello-world      valid" in out and "r4h-s-new-hello-world      valid" in out,
          "NEG reads misrouted (the routing check detects); OLD and NEW PC read valid")
    for what, why in (("commit", "not NEW"), ("surface", "not R1H's"), ("oldstream", "not R1H's wire"), ("timeline", "no clean meter timeline")):
        code, out = smoke(fresh(T, skip={what}))
        check(code == 1 and why in out, f"one defect ({what}) is enough to fail the smoke")
    d = fresh(T)
    shutil.rmtree(d / "r4h-s-neg-hello-world")
    code, out = smoke(d)
    check(code == 1, "a smoke without NEG fails")
    d = fresh(T)
    cell = d / "r4h-s-new-hello-world"
    tl = json.loads((cell / "timeline.json").read_text())
    tl["samples"] = tl["samples"][:-1]
    (cell / "timeline.json").write_text(json.dumps(tl))
    code, out = smoke(d)
    check(code == 1 and "the timeline holds" in out, "a timeline that misses a cloud call the meter counted fails the smoke")
finally:
    shutil.rmtree(T, ignore_errors=True)

# ---------------------------------------------------------------- timeline reconstruction
z = {k: 0 for k in K.END_KEYS + ("chat_requests", "completion_tokens")}
def S(t, **kw):
    return {"t": t, "c": {**z, **kw}, "l": {}}
tl = {"before": {"c": dict(z)}, "polls": 9, "errors": 0, "samples": [
    S(10, chat_requests=1), S(40, chat_requests=1, responses_with_usage=1, completion_tokens=500),
    S(41, chat_requests=2, responses_with_usage=1, completion_tokens=500),
    S(341, chat_requests=3, responses_with_usage=1, completion_tokens=500),            # given up at 300 s and asked again
    S(400, chat_requests=3, responses_with_usage=2, completion_tokens=9500),
    S(420, chat_requests=3, responses_with_usage=3, completion_tokens=10500),
    S(430, chat_requests=4, responses_with_usage=3, completion_tokens=10500)]}
r = K.timeline_calls(tl)
check([c["s"] for c in r["calls"]] == [30, 359, 79], f"FIFO pairing gives each planner call its wall time ({[c['s'] for c in r['calls']]})")
check(r["calls"][0]["out"] == 500 and r["calls"][1]["out"] == 9000, "output tokens per call = the completion_tokens increment at its end")
check(r["max_inflight"] == 2 and r["overlap_samples"] == 1, "two cloud calls in flight at once is counted (the give-up-and-ask-again signature)")
check(r["open"] == [0.0], "a call still open when the timeline ends is reported as open")
r = K.timeline_calls({"before": {"c": dict(z)}, "polls": 3, "errors": 1, "samples": [{"t": 1, "error": "URLError"}, S(5, chat_requests=1), S(9, chat_requests=1, status_5xx=1)]})
check([c["s"] for c in r["calls"]] == [4] and r["errors"] == 1, "a read error sample is skipped; a 5xx ends a call")

# ---------------------------------------------------------------- the decision rule
def cells(pairs):
    out = []
    for i, (o, n) in enumerate(pairs):
        for b, s in (("OLD", o), ("NEW", n)):
            out.append({"group": b, "arm": "PC", "state": "valid", "task": f"t{i}", "k": "k1", "resolved": s, "start": 100.0 + i,
                        "failure_mode": "unset"})
    return out
r = K.paired(cells([(True, False)] * 8 + [(False, True)] * 1 + [(True, True)] * 20))
check(r["old_only"] == 8 and r["new_only"] == 1 and abs(r["p"] - 0.0391) < 1e-3 and K.decide(r).startswith("(a)"),
      f"8 vs 1 discordant (R3R vs R1H's split): p = {r['p']:.4f} -> (a)")
r = K.paired(cells([(True, False)] * 7 + [(False, True)] * 1 + [(True, True)] * 20))
check(K.decide(r).startswith("(b)") and r["p"] > 0.05, f"7 vs 1: p = {r['p']:.4f} -> (b) not shown")
r = K.paired(cells([(False, True)] * 8 + [(True, False)] * 0 + [(True, True)] * 20))
check(K.decide(r).startswith("(b)"), "NEW better than OLD, however clearly, is not (a): the rule is one-directional in its reading")
x = cells([(True, False)] * 8)
x[0]["state"] = "apparatus"
r = K.paired(x)
check(r["pairs"] == 7, "a pair is counted only when both cells are valid")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
