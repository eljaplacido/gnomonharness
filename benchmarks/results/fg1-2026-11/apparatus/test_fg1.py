"""FG1 offline tests: arms -> specs -> the in-container node patch (checked byte-for-byte against the Python reference on
the pinned scaffold, fixtures/surface-scaffold), the tools.toml selector, the cell script (trust grant), the plan, the
FG1 mechanism checks (each one shown able to FAIL), the log relay's key classification, and the analysis.
No model, no Docker, no paid request.      python3 -m pytest -q test_fg1.py
"""
import gzip
import json
import shutil
import socket
import subprocess
import threading
import time
import tomllib
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import analyze_fg1 as AN
import fg1_checks as FC
import run_fg1 as R
import surface_patch as SP

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures" / "surface-scaffold"
FRAGS = SP.load_all()


def files_of(root):
    g = Path(root) / ".gnomon"
    files = {n: (g / n).read_text(encoding="utf-8") for n in SP.FILES if (g / n).exists()}
    prof = {p.name: p.read_text(encoding="utf-8") for p in sorted((g / "profiles").glob("*.toml"))}
    return files, prof


def node_patch(spec, tmp_path):
    root = tmp_path / "root"
    shutil.copytree(FIX, root)
    r = subprocess.run(["node", "-e", SP.compile_js(spec), str(root)], capture_output=True, text=True, timeout=60)
    return r, root

# ------------------------------------------------------------------------------------------------ arms and specs


def test_three_arms_one_variable_each():
    assert set(FRAGS) == {"C", "FG", "SH"}
    sp = R.specs()
    c = sp["C"]["edits"]
    assert [(e["file"], e["table"], e["key"]) for e in c] == [("config.toml", "endpoints.bench", "replay_reasoning")]
    fg = [e for e in sp["FG"]["edits"] if e not in c]
    sh = [e for e in sp["SH"]["edits"] if e not in c]
    assert [(e["file"], e["table"], e["key"], e["literal"]) for e in fg] == [("policy.toml", "verify", "finish_gate", '"v2"')]
    assert sorted((e["file"], e["table"], e["key"], e["literal"]) for e in sh) == [
        ("tools.toml", "tools[name=bash]", "soft_timeout", '"handle"'), ("tools.toml", "tools[name=bash]", "timeout_seconds", "30")]
    for a in R.ARMS:  # the same deadline in every arm
        assert sp[a]["task_args"] == ["--deadline", "1740"], a
        assert sp[a]["role"] == "implementor"


def test_arm_expectations_replace_the_controls():
    sp = R.specs()
    ex = {a: {(x["on"], x["path"]): x for x in sp[a]["expects"]} for a in R.ARMS}
    assert ex["C"][("record", "counters.finish_gate")]["op"] == "absent"
    assert ex["FG"][("record", "counters.finish_gate")]["op"] == "present"
    assert ex["SH"][("record", "counters.finish_gate")]["op"] == "absent"
    assert ex["C"][("surface", "tools.toml:tools[name=bash].soft_timeout")]["op"] == "absent"
    assert ex["SH"][("surface", "tools.toml:tools[name=bash].soft_timeout")]["value"] == "handle"
    assert ex["FG"][("surface", "tools.toml:tools[name=bash].soft_timeout")]["op"] == "absent"
    for a in R.ARMS:
        assert ex[a][("record", "volatile.deadline")]["op"] == "present"


def test_spec_hashes_are_stable():
    a, b = R.specs(), R.specs()
    assert {k: v["sha256"] for k, v in a.items()} == {k: v["sha256"] for k, v in b.items()}
    assert len({v["sha256"] for v in a.values()}) == 3

# ------------------------------------------------------------------------------------------------ the patch


@pytest.mark.parametrize("arm", ["C", "FG", "SH"])
def test_node_patch_equals_python_reference(arm, tmp_path):
    spec = R.specs()[arm]
    r, root = node_patch(spec, tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    out = json.loads(r.stdout)
    assert out["ok"] and out["spec"] == spec["sha256"]
    want_files, want_prof, _ = SP.apply_surface(*files_of(FIX), spec["edits"])
    got_files, got_prof = files_of(root)
    assert got_files == want_files and got_prof == want_prof
    for n, t in got_files.items():
        tomllib.loads(t)  # still valid TOML


def test_sh_edits_only_the_bash_block(tmp_path):
    r, root = node_patch(R.specs()["SH"], tmp_path)
    assert r.returncode == 0, r.stdout
    doc = tomllib.loads((root / ".gnomon" / "tools.toml").read_text())
    before = tomllib.loads((FIX / ".gnomon" / "tools.toml").read_text())
    bash = [t for t in doc["tools"] if t["name"] == "bash"]
    assert len(bash) == 1 and bash[0]["soft_timeout"] == "handle" and bash[0]["timeout_seconds"] == 30
    others = [t for t in doc["tools"] if t["name"] != "bash"]
    assert others == [t for t in before["tools"] if t["name"] != "bash"]
    assert sum(1 for t in before["tools"] if t["name"] == "bash") == 1
    assert [t for t in before["tools"] if t["name"] == "bash"][0]["timeout_seconds"] == 120  # the scaffold's own


def test_selector_refuses_zero_or_two_blocks():
    two = '[[tools]]\nname = "bash"\n\n[[tools]]\nname = "bash"\n'
    e = {"file": "tools.toml", "table": "tools[name=bash]", "key": "soft_timeout", "op": "set", "literal": '"handle"'}
    with pytest.raises(SP.FragmentError):
        SP.apply_text(two, [e])
    with pytest.raises(SP.FragmentError):
        SP.apply_text('[[tools]]\nname = "read"\n', [e])
    out, acts = SP.apply_text('[[tools]]\nname = "read"\n\n[[tools]]\nname = "bash"\ntimeout_seconds = 120\n',
                              [e, dict(e, key="timeout_seconds", literal="30")])
    assert out == '[[tools]]\nname = "read"\n\n[[tools]]\nsoft_timeout = "handle"\nname = "bash"\ntimeout_seconds = 30\n'
    assert [a["action"] for a in acts] == ["inserted", "replaced"]


def test_node_selector_refusal_matches_python(tmp_path):
    root = tmp_path / "r"
    (root / ".gnomon").mkdir(parents=True)
    (root / ".gnomon" / "tools.toml").write_text('[[tools]]\nname = "bash"\n\n[[tools]]\nname = "bash"\n')
    spec = SP.merge([FRAGS["C"], FRAGS["SH"]])
    spec = dict(spec, edits=[e for e in spec["edits"] if e["file"] == "tools.toml"])
    r = subprocess.run(["node", "-e", SP.compile_js(spec), str(root)], capture_output=True, text=True)
    assert r.returncode == 3 and "2 blocks" in json.loads(r.stdout)["error"]


def test_surface_check_reads_selector_paths(tmp_path):
    r, root = node_patch(R.specs()["SH"], tmp_path)
    agent = tmp_path / "agent"
    agent.mkdir()
    shutil.copy(root / ".gnomon" / "tools.toml", agent / "surface-tools.toml")
    res = SP.check_cell([{"on": "surface", "path": "tools.toml:tools[name=bash].soft_timeout", "op": "equals",
                          "value": "handle"}], agent, None)
    assert res[0]["result"] == "pass"
    shutil.copy(FIX / ".gnomon" / "tools.toml", agent / "surface-tools.toml")
    res = SP.check_cell([{"on": "surface", "path": "tools.toml:tools[name=bash].soft_timeout", "op": "equals",
                          "value": "handle"}], agent, None)
    assert res[0]["result"] == "fail"

# ------------------------------------------------------------------------------------------------ the cell script


def test_run_script_grants_trust_before_the_task():
    s = SP.run_script(R.specs()["C"], "do it", "/* patch */")
    g, t, p = s.index("gnomon trust grant --dir \"$GN_ROOT\""), s.index("gnomon task "), s.index("fg1-surface-patch.json")
    assert p < g < t
    assert "--deadline 1740 --yes --json" in s
    assert "surface-tools.toml" in s
    n = SP.run_script(R.specs()["C"], "do it", "/* patch */", trust_grant=False)
    assert "trust grant" not in n and "gnomon task " in n


def test_adapter_names():
    src = (HERE / "gnomon_harbor_fg1.py").read_text()
    assert "FG1_SPEC" in src and "AS1_SPEC" not in src and "class GnomonFG1" in src

# ------------------------------------------------------------------------------------------------ the plan


def test_plan_is_complete_seeded_and_balanced():
    w = R.plan()
    assert w == R.plan() and len(w) == 87
    assert Counter(x["task"] for x in w) == {t: 3 for t in R.all_tasks()}
    assert [x["attempt"] for x in w] == [1] * 29 + [2] * 29 + [3] * 29
    for x in w:
        assert sorted(x["order"]) == sorted(R.ARMS) and sorted(x["slots"].values()) == [0, 1, 2]
        assert x["slots"][x["order"][0]] == 0
    first = Counter(x["order"][0] for x in w)
    assert set(first) == set(R.ARMS) and min(first.values()) >= 20  # every arm starts first sometimes
    committed = HERE.parent / "PLAN.json"
    if committed.exists():
        assert json.loads(committed.read_text())["waves"] == w


def test_amendment1_relay_slots_disjoint_from_as1():
    """Amendment 1: plan slot j runs on relay slot 3 + j; never one of AS1's 0-2; log relays 4743-4745."""
    assert R.SLOTS == (3, 4, 5) and R.SLOT_BASE == 3 and not set(R.SLOTS) & set(R.AS1_SLOTS)
    for x in R.plan():
        assert sorted(R.SLOT_BASE + j for j in x["slots"].values()) == list(R.SLOTS)
    assert [R.LOG_PORT0 + s for s in R.SLOTS] == [4743, 4744, 4745]
    src = (HERE / "run_fg1.py").read_text()
    assert "as1_runners()" not in src.split("def wait_for_wave")[1].split("def ")[0]  # no AS1 wait per wave


def test_peak_windows():
    import datetime as dt
    sat = dt.datetime(2026, 11, 7, 2, 0, tzinfo=dt.timezone.utc)
    mon = dt.datetime(2026, 11, 9, 2, 0, tzinfo=dt.timezone.utc)
    assert not R.peak(sat) and R.peak(mon)
    assert R.next_offpeak(dt.datetime(2026, 11, 9, 0, 30, tzinfo=dt.timezone.utc)).hour == 4

# ------------------------------------------------------------------------------------------------ mechanism checks


def mkcell(tmp_path, arm, auth="placeholder", tools=("bash",), audit=(), record=None, grant=True, reasoning=True):
    a = tmp_path / f"agent-{arm}"
    w = tmp_path / f"wire-{arm}"
    (a / "audit").mkdir(parents=True)
    w.mkdir()
    rows = []
    for n in (1, 2, 3):
        rows.append({"n": n, "auth": auth, "req": {"tools": list(tools), "assistant_with_reasoning": (n - 1) if reasoning else 0},
                     "resp": {"reasoning_chars": 10, "tool_calls": [{"name": "bash"}] if n < 3 else []}})
    (w / "calls.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (a / "audit" / "t.jsonl").write_text("".join(json.dumps(x) + "\n" for x in
                                                 [{"kind": "session_start"}, {"kind": "trust", "decision": "trusted"}, *audit]))
    if grant:
        (a / "fg1-trust-grant.txt").write_text("Trusted /app at surface abc:\n  endpoint bench  sends $OPENAI_API_KEY to 172.17.0.1\n")
    (a / "gnomon-task.json").write_text(json.dumps(record or {"stop_reason": "answered", "counters": {}, "volatile": {}}))
    return a, w


def results(arm, a, w):
    return {r["check"]: r["result"] for r in FC.cell_checks(arm, a, w)}


def test_checks_pass_on_good_cells(tmp_path):
    assert set(results("C", *mkcell(tmp_path, "C")).values()) == {"pass"}
    fg = mkcell(tmp_path, "FG", audit=[{"kind": "finish_gate", "action": "fire"}])
    assert results("FG", *fg)["gate_audit"] == "pass" and not FC.failed(FC.cell_checks("FG", *fg))
    sh = mkcell(tmp_path, "SH", tools=("bash", "job"), audit=[{"kind": "job", "event": "yield"}],
                record={"volatile": {"tool_calls": [{"tool": "bash", "duration_ms": 30100}]}})
    assert not FC.failed(FC.cell_checks("SH", *sh))


def test_key_absent_fails(tmp_path):
    assert results("C", *mkcell(tmp_path, "C", auth="absent"))["key"] == "fail"


def test_trust_clamped_or_missing_grant_fails(tmp_path):
    a, w = mkcell(tmp_path, "C", audit=[{"kind": "trust", "decision": "clamped"}])
    assert results("C", a, w)["trust"] == "fail"
    a, w = mkcell(tmp_path / "x", "C")
    (a / "fg1-trust-grant.txt").write_text("Nothing to trust\n")
    assert results("C", a, w)["trust"] == "fail"


def test_job_tool_and_audit_are_arm_specific(tmp_path):
    assert results("C", *mkcell(tmp_path, "C", tools=("bash", "job")))["job_tool"] == "fail"
    assert results("FG", *mkcell(tmp_path, "FG", audit=[{"kind": "job", "event": "yield"}]))["job_audit"] == "fail"
    assert results("SH", *mkcell(tmp_path, "SH", tools=("bash",)))["job_tool"] == "fail"
    sh = mkcell(tmp_path / "y", "SH", tools=("bash", "job"),
                record={"volatile": {"tool_calls": [{"tool": "bash", "duration_ms": 90000}]}})
    assert results("SH", *sh)["job_audit"] == "fail"  # a command ran 90 s past a 30 s yield: not yielded


def test_gate_outside_fg_fails_and_replay_missing_fails(tmp_path):
    assert results("SH", *mkcell(tmp_path, "SH", tools=("bash", "job"),
                                 audit=[{"kind": "finish_gate", "action": "fire"}]))["gate_audit"] == "fail"
    assert results("C", *mkcell(tmp_path / "z", "C", reasoning=False))["replay"] == "fail"


def test_no_wire_is_unverifiable_not_fail(tmp_path):
    r = {x["check"]: x["result"] for x in FC.cell_checks("C", None, tmp_path / "nope")}
    assert set(r.values()) == {"unverifiable"}


def test_gate_stats():
    s = FC.gate_stats({"counters": {"finish_gate": {"outcome": "passed", "rounds": 1}}})
    assert s["applicable"] and s["fired"]
    s = FC.gate_stats({"counters": {"finish_gate": {"outcome": "skipped_budget", "rounds": 0}}})
    assert s["applicable"] and not s["fired"]
    assert not FC.gate_stats({"counters": {"finish_gate": {"outcome": "not_applicable", "rounds": 0}}})["applicable"]

# ------------------------------------------------------------------------------------------------ log relay


class Up(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        self.wfile.write(b'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')


def test_log_relay_classifies_the_key_without_logging_it(tmp_path):
    import urllib.request
    up = ThreadingHTTPServer(("127.0.0.1", 0), Up)
    threading.Thread(target=up.serve_forever, daemon=True).start()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    p = subprocess.Popen(["node", str(HERE / "log-relay.mjs"), f"127.0.0.1:{port}", f"http://127.0.0.1:{up.server_address[1]}",
                          str(tmp_path / "w")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env={"PATH": "/usr/bin:/bin:" + str(Path(shutil.which("node")).parent), "FG1_KEY_PLACEHOLDER": "ph"})
    try:
        time.sleep(1.0)
        for h in ({"authorization": "Bearer ph"}, {}, {"authorization": "Bearer something-else"}):
            req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", method="POST",
                                         data=json.dumps({"model": "m", "messages": [], "tools": []}).encode(),
                                         headers={"content-type": "application/json", **h})
            urllib.request.urlopen(req, timeout=10).read()
        time.sleep(0.5)
        rows = [json.loads(l) for l in (tmp_path / "w" / "calls.jsonl").read_text().splitlines()]
        assert [r["auth"] for r in sorted(rows, key=lambda r: r["n"])] == ["placeholder", "absent", "other"]
        assert "something-else" not in (tmp_path / "w" / "calls.jsonl").read_text()
    finally:
        p.terminate()
        up.shutdown()

# ------------------------------------------------------------------------------------------------ analysis


def outcome(arm, task, att, solved, valid=True, wave=None, capped=False, usd=0.1, frac=0.5, fg=None, yields=0):
    return {"cell": f"{wave}-{arm}-{task}", "wave": wave or f"a{att}w{task}", "attempt": att, "arm": arm, "task": task,
            "valid": valid, "invalid_reason": None if valid else "mechanism: key", "solved": solved and valid,
            "capped": capped, "usd": usd, "frac": frac, "agent_s": 600.0, "finish_gate": fg, "job_yields": yields}


def test_analysis_rerun_replaces_wave_and_buckets_sum(tmp_path):
    outs = []
    for t in ("t1", "t2"):
        for att in (1, 2, 3):
            w = f"a{att}{t}"
            outs += [outcome("C", t, att, False, wave=w), outcome("SH", t, att, False, wave=w, yields=1),
                     outcome("FG", t, att, True, wave=w, fg={"applicable": True, "fired": True, "outcome": "passed"})]
    outs[0]["valid"] = False  # C t1 a1 invalid -> the wave is re-run
    outs += [outcome("C", "t1", 1, False, wave="a1t1r"), outcome("SH", "t1", 1, True, wave="a1t1r", yields=1),
             outcome("FG", "t1", 1, True, wave="a1t1r", fg={"applicable": True, "fired": True, "outcome": "passed"})]
    eff = AN.effective(outs)
    assert len(eff) == 18 and not any(o["wave"] == "a1t1" for o in eff)
    f = tmp_path / "o.jsonl"
    f.write_text("".join(json.dumps(o) + "\n" for o in outs))
    AN.main(["--outcomes", str(f), "--out", str(tmp_path / "s.txt")])
    s = (tmp_path / "s.txt").read_text()
    assert "FG vs C: 6 valid" in s and "solved FG 6 vs C 0" in s
    assert "DECISION FG: ADOPT" in s
    assert "DECISION SH: NOT ADOPTED" in s  # 1 of 6: lower bound 0


def test_analysis_guards_block_adoption(tmp_path):
    outs = []
    for i in range(10):
        t = f"t{i}"
        outs += [outcome("C", t, 1, False, wave=f"w{i}", usd=0.1), outcome("SH", t, 1, False, wave=f"w{i}", yields=1),
                 outcome("FG", t, 1, True, wave=f"w{i}", usd=0.2, capped=i < 4,
                         fg={"applicable": True, "fired": True, "outcome": "passed"})]
    f = tmp_path / "o.jsonl"
    f.write_text("".join(json.dumps(o) + "\n" for o in outs))
    AN.main(["--outcomes", str(f), "--out", str(tmp_path / "s.txt")])
    s = (tmp_path / "s.txt").read_text()
    assert "DECISION FG: NOT ADOPTED (caps +4 > +3; spend ratio 2.00 > 1.3)" in s

# ------------------------------------------------------------------------------------------------ Amendment 2: interim looks

import interim_fg1 as IM  # noqa: E402


def _rows(solve: dict, attempts=(1,), tasks=29):
    """Synthetic outcomes: solve[arm](task_index, attempt) -> bool. FG fires, SH yields (mechanisms delivered)."""
    rows = []
    for att in attempts:
        for i in range(tasks):
            for arm in R.ARMS:
                rows.append({"cell": f"fg1-a{att}w{i:02d}-{arm}-t{i}", "wave": f"a{att}w{i:02d}", "attempt": att,
                             "arm": arm, "task": f"t{i}", "valid": True, "invalid_reason": None,
                             "solved": bool(solve[arm](i, att)), "capped": False, "usd": 0.1, "frac": 0.5,
                             "agent_s": 600, "job_yields": 1 if arm == "SH" else 0,
                             "finish_gate": {"applicable": True, "fired": True, "outcome": "passed"} if arm == "FG" else None})
    return rows


def _write(tmp_path, rows):
    f = tmp_path / "outcomes.jsonl"
    f.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return f


def test_interim_boundaries_are_obrien_fleming_at_alpha_025():
    c = IM.boundaries(list(IM.PLANNED_T))
    assert [round(x, 2) for x in c] == [3.71, 2.51, 1.99]
    assert abs(IM.spend(1.0) - 0.025) < 1e-12 and IM.spend(1 / 3) < 2e-4
    assert c == IM.boundaries(list(IM.PLANNED_T))  # deterministic (seeded)


def test_interim_look1_futility_and_efficacy_and_stop(tmp_path, monkeypatch):
    monkeypatch.setattr(IM, "INTERIM_DIR", tmp_path / "interim")
    # FG far better than C (efficacy at look 1 needs >= 14 discordant wins: 0.5^14 < 1.04e-4), SH worse (futility)
    rows = _rows({"C": lambda i, a: i == 0, "FG": lambda i, a: i < 20, "SH": lambda i, a: False})
    res, text = IM.look(1, _write(tmp_path, rows))
    assert res["comparisons"]["FG"]["decision"] == "efficacy", text
    assert res["comparisons"]["SH"]["decision"] == "futility", text
    assert res["stop_study"] is True
    # a modest FG gain does not cross the O'Brien-Fleming boundary at look 1 -> continue
    rows = _rows({"C": lambda i, a: i == 0, "FG": lambda i, a: i < 4, "SH": lambda i, a: False})
    res, text = IM.look(1, _write(tmp_path, rows))
    assert res["comparisons"]["FG"]["decision"] == "continue" and res["stop_study"] is False


def test_interim_guard_blocks_early_efficacy(tmp_path, monkeypatch):
    monkeypatch.setattr(IM, "INTERIM_DIR", tmp_path / "interim")
    rows = _rows({"C": lambda i, a: False, "FG": lambda i, a: i < 20, "SH": lambda i, a: False})
    for r in rows:
        if r["arm"] == "FG":
            r["usd"] = 0.5  # spend ratio 5 > 1.3
    res, _ = IM.look(1, _write(tmp_path, rows))
    assert res["comparisons"]["FG"]["efficacy_crossed"] and res["comparisons"]["FG"]["decision"].startswith("continue")


def test_interim_look2_uses_both_attempts_and_keeps_earlier_decisions(tmp_path, monkeypatch):
    monkeypatch.setattr(IM, "INTERIM_DIR", tmp_path / "interim")
    (tmp_path / "interim").mkdir()
    (tmp_path / "interim" / "look1.json").write_text(json.dumps({"look": 1, "stop_study": False, "comparisons": {
        "FG": {"t": 29 / 87, "decision": "continue"}, "SH": {"t": 29 / 87, "decision": "futility"}}}))
    rows = _rows({"C": lambda i, a: False, "FG": lambda i, a: i < 3, "SH": lambda i, a: False}, attempts=(1, 2, 3))
    res, text = IM.look(2, _write(tmp_path, rows))
    assert res["comparisons"]["FG"]["n"] == 58  # attempt 3 rows excluded
    assert res["comparisons"]["SH"]["decision"] == "futility" and "already decided" in res["comparisons"]["SH"]["note"]
    assert abs(res["comparisons"]["FG"]["c"] - 2.511) < 0.01


def test_runner_interim_gate_runs_before_attempt_2_and_stops(tmp_path, monkeypatch):
    monkeypatch.setattr(IM, "INTERIM_DIR", tmp_path / "interim")
    monkeypatch.setattr(R, "INTERIM_DIR", tmp_path / "interim")
    monkeypatch.setattr(R, "STATUS", tmp_path / "STATUS.txt")
    monkeypatch.setattr(R, "commit", lambda *a, **k: True)
    rows = _rows({"C": lambda i, a: i == 0, "FG": lambda i, a: i < 20, "SH": lambda i, a: False})
    monkeypatch.setattr(R, "OUTCOMES", _write(tmp_path, rows))
    ran = []
    monkeypatch.setattr(R, "wait_for_wave", lambda args: ran.append("wait"))
    waves = [w for w in R.plan() if w["attempt"] == 2][:1]

    class A:
        push = False
    assert R.execute(waves, A(), {}, {}, None, interim=True) == "stopped"
    assert not ran and (tmp_path / "interim" / "look1.json").exists() and R.stopped_look() == 1


# ---------------------------------------------------------------- Amendment 3: two lanes, one queue, claims, barriers
import run_fg1_lanes as L  # noqa: E402


def _lanes(tmp_path, monkeypatch, lane, rows=()):
    monkeypatch.setattr(L, "CLAIMS", tmp_path / "claims")
    monkeypatch.setattr(L, "LOCK", tmp_path / ".lanes.lock")
    monkeypatch.setattr(L, "LANE", lane)
    monkeypatch.setattr(L, "GA", None)
    monkeypatch.setattr(R, "STATUS", tmp_path / "STATUS.txt")
    monkeypatch.setattr(R, "INTERIM_DIR", tmp_path / "interim")
    monkeypatch.setattr(IM, "INTERIM_DIR", tmp_path / "interim")
    monkeypatch.setattr(R, "commit", lambda *a, **k: True)
    monkeypatch.setattr(L, "commit", lambda *a, **k: True)
    monkeypatch.setattr(R, "OUTCOMES", _write(tmp_path, list(rows)))
    monkeypatch.setattr(R, "wait_for_wave", lambda args: None)
    monkeypatch.setattr(L, "wait_hub", lambda args: None)


class _Args:
    push = False


def test_lanes_claim_is_exclusive_and_owned(tmp_path, monkeypatch):
    _lanes(tmp_path, monkeypatch, "gx10")
    assert L.claim("a1w09") and L.claim("a1w09")  # own claim: idempotent
    monkeypatch.setattr(L, "LANE", "hub")
    assert not L.claim("a1w09") and L.claim("a1w10")
    assert L.claim_owner("a1w09") == "gx10" and L.claim_owner("a1w10") == "hub"


def test_lanes_take_plan_order_skipping_done_and_other_lanes_claims(tmp_path, monkeypatch):
    waves = R.plan()
    done = [{"cell": c, "usd": 0.0} for w in waves[:2] for c in L.cells_of(w).values()]
    _lanes(tmp_path, monkeypatch, "hub", done)
    monkeypatch.setattr(L, "LANE", "gx10")
    L.claim(waves[2]["id"])
    monkeypatch.setattr(L, "LANE", "hub")
    ran = []

    def fake_wave(w, *a):
        ran.append(w["id"])
        if len(ran) == 2:
            monkeypatch.setattr(R, "stopped_look", lambda: 1)  # end the loop
        return {"aborted": False, "hold": False, "spent": 0.0}
    monkeypatch.setattr(L, "run_wave", fake_wave)
    monkeypatch.setattr(L, "done_cells", lambda: {d["cell"] for d in done} | {c for w in waves if w["id"] in ran
                                                                               for c in L.cells_of(w).values()})
    assert L.execute(waves[:6], _Args(), {}, {}, None, interim=False) == "stopped"
    assert ran == [waves[3]["id"], waves[4]["id"]]  # w0, w1 done; w2 the gx10 lane's


def test_lanes_barrier_holds_attempt_2_until_attempt_1_complete_then_look_runs(tmp_path, monkeypatch):
    waves = R.plan()
    a1 = [w for w in waves if w["attempt"] == 1]
    # all of attempt 1 but its last wave done: a lane must not start attempt 2, it waits (barrier)
    rows = [o for o in _rows({"C": lambda i, a: i == 0, "FG": lambda i, a: i < 20, "SH": lambda i, a: False})
            if o["attempt"] == 1]
    _lanes(tmp_path, monkeypatch, "hub", rows)
    monkeypatch.setattr(L, "LANE", "gx10")
    L.claim(a1[-1]["id"])           # the other lane is running attempt 1's last wave
    monkeypatch.setattr(L, "LANE", "hub")
    names = {o["cell"] for o in rows}
    done_ids = {w["id"] for w in a1[:-1]}
    monkeypatch.setattr(L, "done_cells", lambda: {c for w in waves if w["id"] in done_ids for c in L.cells_of(w).values()})
    slept = []

    def fake_sleep(s):
        slept.append(s)
        done_ids.add(a1[-1]["id"])  # the other lane finishes during the wait
    monkeypatch.setattr(L.time, "sleep", fake_sleep)
    monkeypatch.setattr(L, "run_wave", lambda *a: pytest.fail("no attempt-2 wave may run: look 1 stops the study"))
    # rows give FG 20 solves vs C 1 over 29 pairs: look 1 crosses efficacy for FG and futility for SH -> stop
    assert L.execute(waves[:30], _Args(), {}, {}, None, interim=True) == "stopped"
    assert slept and (tmp_path / "interim" / "look1.json").exists() and names
    assert "BARRIER" in (tmp_path / "STATUS.txt").read_text()


def test_lanes_budget_reserves_for_the_other_lanes_wave(tmp_path, monkeypatch):
    waves = R.plan()
    _lanes(tmp_path, monkeypatch, "gx10", [{"cell": "x", "usd": 46.5}])
    L.claim(waves[0]["id"])
    monkeypatch.setattr(L, "LANE", "hub")
    seen = []
    monkeypatch.setattr(L.time, "sleep", lambda s: (seen.append(s), monkeypatch.setattr(R, "stopped_look", lambda: 1)))
    monkeypatch.setattr(L, "run_wave", lambda *a: pytest.fail("46.5 + 2 x 2 > 50: no wave while the other is in flight"))
    assert L.execute(waves[:3], _Args(), {}, {}, None, interim=False) == "stopped" and seen


def test_lanes_honour_the_go_pause_line_without_go_allowance(tmp_path, monkeypatch):
    _lanes(tmp_path, monkeypatch, "hub")
    (tmp_path / "STATUS.txt").write_text("t PAUSED: Go allowance — weekly\n")
    assert L.go_paused()
    (tmp_path / "STATUS.txt").write_text("t PAUSED: Go allowance — weekly\nt RESUMED Go allowance\n")
    assert L.go_paused() is None


def test_hub_cell_cmd_matches_the_gx10_harbor_flags():
    s = L.H.cell_cmd("fg1-a1w09-C-t", "t", "abc", 4746, R.MODEL, str(R.CAP_S / R.TB4_AGENT_TIMEOUT_S),
                     R.BUILD_TIMEOUT_MULT, R.GNOMON_AGENT, R.PLACEHOLDER)
    for part in ("-n 1 -k 1", "--force-build", "--environment-build-timeout-multiplier 4.0",
                 "-a gnomon_harbor_fg1:GnomonFG1", "-m openai/deepseek-v4.1-flash",
                 "base_url=http://100.86.231.23:4746/openai/v1", "--agent-timeout-multiplier 0.0625",
                 "--ae OPENAI_API_KEY=p2g-relay-placeholder", "FG1_SPEC_SHA256=abc", "GNOMON_REL_BASE=http://100.86.231.23:4759"):
        assert part in s, part
    assert "\r\n" in s

# ------------------------------------------------------------------------------------------------ Amendment 5: transport

import transport_fg1 as T  # noqa: E402


def _calls(d, statuses, t0="2026-11-07T06:00:00", step=10):
    """A calls.jsonl with one call every `step` s; status None = client abort, 'err' = relay error."""
    import datetime as dt
    d.mkdir(parents=True, exist_ok=True)
    base = dt.datetime.fromisoformat(t0)
    lines = []
    for i, st in enumerate(statuses):
        t = (base + dt.timedelta(seconds=i * step)).isoformat() + ".000Z"
        r = {"n": i + 1, "t": t, "wall_ms": 500}
        if st is None:
            r["aborted"] = True
        elif st == "err":
            r["error"] = "ECONNRESET"
        else:
            r["status"] = st
        lines.append(json.dumps(r))
    (d / "calls.jsonl").write_text("\n".join(reversed(lines)) + "\n")  # written at reply end: any order


def test_transport_fields_count_429s_and_seconds_lost(tmp_path):
    _calls(tmp_path / "w", [200, 429, 429, 429, 200, None, 503, 200, 400, "err"])
    t = T.cell_transport(tmp_path / "w")
    assert (t["wire_calls"], t["wire_429"], t["wire_5xx"], t["wire_4xx_other"], t["wire_errors"], t["wire_aborted"]) \
        == (10, 3, 1, 1, 1, 1)
    # 429 run 10 s -> 40 s (30 s), 503 at 60 s -> 70 s (10 s), 400+err from 80 s to the end of the last call (10.5 s)
    assert t["wire_lost_s"] == 50.5 and t["wire_429_share"] == 0.3 and t["wire_fail_share"] == 0.6
    assert T.cell_transport(tmp_path / "missing") is None


def test_transport_sensitivity_drops_only_asymmetric_waves_and_never_moves_the_look(tmp_path, monkeypatch):
    monkeypatch.setattr(IM, "INTERIM_DIR", tmp_path / "interim")
    rows = _rows({"C": lambda i, a: i == 0, "FG": lambda i, a: i < 4, "SH": lambda i, a: False})
    (tmp_path / "ledger").mkdir()
    f = _write(tmp_path / "ledger", rows)  # runs/ resolves to tmp_path / "runs", as ledger/../runs in the study
    base, _ = IM.look(1, f)  # no wire logs at all: every wave unmeasured, nothing dropped
    assert base["transport_sensitivity"]["unmeasured_waves"] and not base["transport_sensitivity"]["flagged_waves"]
    runs = tmp_path / "runs"
    for r in rows:
        w, arm = r["wave"], r["arm"]
        st = [200] * 40
        if w == "a1w00" and arm == "FG":
            st = [200] * 22 + [429] * 18                   # 45 % 429s vs clean C and SH: asymmetric -> dropped
        if w == "a1w01":
            st = [200] * 30 + [429] * 10                   # every arm 25 %: symmetric -> kept
        if w == "a1w02" and arm == "C":
            st = [200] * 39 + [429]                        # 2.5 %, 10 s lost: neither handicapped nor clean
        _calls(runs / r["cell"] / "wire", st)
    res, text = IM.look(1, f)
    ts = res["transport_sensitivity"]
    assert list(ts["flagged_waves"]) == ["a1w00"] and not ts["unmeasured_waves"]
    assert ts["arm_totals"]["FG"]["wire_429"] == 28 and ts["arm_totals"]["C"]["wire_429"] == 11
    assert ts["contrasts"]["FG"]["all"]["n"] == 29 and ts["contrasts"]["FG"]["without_flagged"]["n"] == 28
    assert "DESCRIPTIVE, never decision-bearing" in text
    # the decision-bearing part of the look is identical with and without the wire logs
    strip = lambda r: {k: v for k, v in r.items() if k != "transport_sensitivity"}  # noqa: E731
    assert json.dumps(strip(res), sort_keys=True) == json.dumps(strip(base), sort_keys=True)
    # and the final analysis reports it beside the decision
    AN.main(["--outcomes", str(f), "--out", str(tmp_path / "s.txt")])
    s = (tmp_path / "s.txt").read_text()
    assert "Amendment 5 — transport sensitivity at the final" in s and "a1w00 [FG 429 18/40" in s


def test_transport_backfill_adds_fields_and_changes_nothing_else(tmp_path):
    led, runs = tmp_path / "ledger", tmp_path / "runs"
    led.mkdir()
    rows = [{"cell": f"fg1-a1w00-{a}-t0", "wave": "a1w00", "arm": a, "valid": a != "SH", "solved": False}
            for a in R.ARMS]
    rows.append({"cell": "fg1-a1w01-C-t1", "wave": "a1w01", "arm": "C", "valid": True, "wire_429": 0})  # already has
    (led / "outcomes.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (led / "covariates.jsonl").write_text(json.dumps({"wave": "a1w00", "load1_max": 3.0}) + "\n")
    _calls(runs / "fg1-a1w00-C-t0" / "wire", [200, 429, 200])
    _calls(runs / "fg1-a1w00-FG-t0" / "wire", [200, 200])
    o, c = T.backfill(led, runs, tmp_path / ".lock")
    assert (o, c) == (2, 1)  # SH has no wire log (left as is), a1w01 already had the fields
    new = [json.loads(l) for l in (led / "outcomes.jsonl").read_text().splitlines()]
    for old, n in zip(rows, new):
        assert {k: n[k] for k in old} == old  # every existing field unchanged, validity included
    assert new[0]["wire_429"] == 1 and new[0]["wire_source"] == "backfill-a5" and "wire_429" not in new[2]
    cov = json.loads((led / "covariates.jsonl").read_text())
    assert cov["wire_429_by_arm"] == {"C": 1, "FG": 0} and cov["load1_max"] == 3.0
    assert T.backfill(led, runs, tmp_path / ".lock") == (0, 0)  # idempotent

# ------------------------------------------------------------------------------------------------ Amendment 6: HTTP 402


def _wire(d, rows):
    """rows: (status, body) per call, written as the log relay writes them (calls.jsonl + resp-NNNN.sse.gz)."""
    d.mkdir(parents=True, exist_ok=True)
    with open(d / "calls.jsonl", "w", encoding="utf-8") as f:
        for i, (st, body) in enumerate(rows, 1):
            r = {"n": i, "t": f"2026-11-07T13:55:{i:02d}.000Z", "status": st, "resp": {}}
            if st == 200:
                r["resp"] = {"usage": {"opencode": {"billing_source": "go-plus", "list_cost": 0.001}}}
            f.write(json.dumps(r) + "\n")
            (d / f"resp-{i:04d}.sse.gz").write_bytes(gzip.compress(body.encode()))


def _ga_sandbox(tmp_path, monkeypatch):
    GA = R.GA
    d = tmp_path / "go-accounts"
    d.mkdir()
    for k, v in {"DIR": d, "ACCOUNTS": d / "ACCOUNTS.json", "METER": d / "meter.json", "EVENTS": d / "events.jsonl",
                 "FLAG": d / "EXHAUSTED.json", "SWITCHING": d / "SWITCHING", "INFLIGHT": d / "inflight",
                 "LOCK": d / ".lock", "STATUS_FILES": []}.items():
        monkeypatch.setattr(GA, k, v)
    monkeypatch.setattr(GA, "_counters", lambda port: None)  # never read the live relays
    (d / "ACCOUNTS.json").write_text(json.dumps({"current": "acct1", "accounts": {"acct1": {
        "plan": "go-plus", "billing_label": "go-plus", "baseline": {"weekly_remaining_usd": 90.0}}}}))
    return GA


FUNDS = '{"error":{"type":"invalid_request_error","message":"Insufficient account funds"}}'
OVERLOADED = '{"error":{"type":"server_error","message":"Upstream request failed: [overloaded] busy"}}'


def test_http_402_is_exhaustion_and_pauses_every_runner_before_the_next_wave(tmp_path, monkeypatch):
    GA = _ga_sandbox(tmp_path, monkeypatch)
    # negative control first: ordinary calls and a 429 [overloaded] say nothing about the account
    _wire(tmp_path / "ok", [(200, "data: {}"), (429, OVERLOADED), (200, "data: {}")])
    s = GA.scan_cell(tmp_path / "ok")
    assert s["exhausted"] is None and s["overloaded_429"] == 1
    assert GA.blockers(2.0, "fg1") == []
    # a cell that died part-way (a2w06/a2w07 shape) and one refused at call 1 (a2w08-a2w17 shape)
    _wire(tmp_path / "part", [(200, "data: {}")] * 3 + [(402, FUNDS)])
    _wire(tmp_path / "first", [(402, FUNDS)])
    _wire(tmp_path / "bare", [(402, "")])  # a 402 whose body was not kept is still the account
    assert GA.scan_cell(tmp_path / "part")["exhausted"] == "HTTP 402 Insufficient account funds at call 4"
    assert GA.scan_cell(tmp_path / "first")["exhausted"] == "HTTP 402 Insufficient account funds at call 1"
    assert GA.scan_cell(tmp_path / "bare")["exhausted"] == "HTTP 402 payment required at call 1"
    # the FG1 scorer path: exhausted -> apparatus-invalid reason + the shared flag -> wave_gate blocks BOTH studies
    GA.flag_exhausted(GA.scan_cell(tmp_path / "first")["exhausted"], "fg1-a2w08-C-x")
    assert json.loads(GA.FLAG.read_text())["account"] == "acct1"
    for study in ("fg1", "fg1-hub", "as1"):
        why = GA.blockers(2.0, study)
        assert why and "acct1 exhausted: HTTP 402 Insufficient account funds" in why[0], (study, why)
    monkeypatch.setattr(GA, "POLL_S", 0)
    calls = []
    monkeypatch.setattr(GA.time, "sleep", lambda s: (calls.append(s), (_ for _ in ()).throw(KeyboardInterrupt)))
    with pytest.raises(KeyboardInterrupt):
        GA.wave_gate("as1", "s02w00", 2.0)  # blocks (would poll forever) instead of registering the wave
    assert calls and not list(GA.INFLIGHT.glob("*.json"))
    assert "PAUSED" in GA.EVENTS.read_text() and "EXHAUSTED" in GA.EVENTS.read_text()


def test_fg1_score_marks_a_402_cell_apparatus_invalid(tmp_path, monkeypatch):
    GA = _ga_sandbox(tmp_path, monkeypatch)
    out, jobs = tmp_path / "runs", tmp_path / "jobs"
    monkeypatch.setattr(R, "OUT", out)
    monkeypatch.setattr(R, "JOBS", jobs)
    cid = "fg1-a2w07-C-cargo-flight-dispatch"
    _wire(out / cid / "wire", [(200, "data: {}")] * 5 + [(402, FUNDS)])
    (out / cid / "cell.json").write_text(json.dumps({
        "task": "cargo-flight-dispatch", "slot": 4, "delta": {"responses_with_usage": 5, "chat_requests": 6},
        "trial": {"reward": {"reward": 0.0}, "agent_version": "gnomon v0.4.5 f8c8a396435127f7 x"}}))
    monkeypatch.setattr(R.SP, "check_cell", lambda *a: [])
    monkeypatch.setattr(R.FC, "cell_checks", lambda *a: [])
    w = {"id": "a2w07", "attempt": 2, "order": ["SH", "C", "FG"]}
    o = R.score(cid, "C", {"expects": []}, {"version": "0.4.5", "commit": "f8c8a396435127f7"}, w)
    assert o["valid"] is False and o["solved"] is False
    assert o["invalid_reason"] == "apparatus: Go allowance — HTTP 402 Insufficient account funds at call 6"
    assert GA.FLAG.exists()
