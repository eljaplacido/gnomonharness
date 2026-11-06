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
