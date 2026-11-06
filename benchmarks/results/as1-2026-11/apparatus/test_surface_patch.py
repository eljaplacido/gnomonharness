"""Offline tests of AS1's arms-as-data path: fragments -> merged spec -> the in-container node patch, checked against
the Python reference on the real v0.4.2 scaffold (fixtures/surface-v042), plus the per-cell mechanism checks and the
pre-registered cell scoring in run_as1.py. No model, no Docker, no network.   python3 -m pytest -q test_surface_patch.py
"""
import gzip
import json
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest

import surface_patch as SP

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures" / "surface-v044"  # Amendment 1: the pinned build's scaffold (v042 kept for reference)
FRAGS = SP.load_all()
P2G_PATCH = "/* P2G _PATCH stand-in for script rendering */"


def surface_files():
    g = FIX / ".gnomon"
    files = {n: (g / n).read_text(encoding="utf-8") for n in SP.FILES}
    profiles = {p.name: p.read_text(encoding="utf-8") for p in sorted((g / "profiles").glob("*.toml"))}
    return files, profiles


def run_node(spec, tmp_path):
    root = tmp_path / "root"
    shutil.copytree(FIX, root)
    r = subprocess.run(["node", "-e", SP.compile_js(spec), str(root)], capture_output=True, text=True, timeout=60)
    return r, root


def combos():
    out = []
    for f in FRAGS.values():
        if f.family == "control":
            continue
        for b in f.branches:
            out.append((f"CTL.{b}", f.id))
    out += [(c, None) for c in ("CTL.A", "CTL.B", "CTL.C")]
    return out


def test_fragments_load_unique_and_valid():
    assert {"CTL.A", "CTL.B", "CTL.C", "AA", "W", "D", "GC", "GR", "GCD", "EL", "EH", "EM", "S", "ENV", "TODO",
            "EDIT", "PKG", "P0", "PG", "PK"} <= set(FRAGS)
    for f in FRAGS.values():
        assert f.status in SP.STATUSES and f.family and f.branches
    assert FRAGS["W"].branches == ["A", "C"]     # absorbed by branch B's control
    assert FRAGS["AA"].edits == [] and FRAGS["AA"].family == "null"
    assert {f.family for f in FRAGS.values() if f.id in ("EL", "EH", "EM")} == {"reasoning_effort"}


@pytest.mark.parametrize("ctl,arm", combos())
def test_node_patch_equals_python_reference(ctl, arm, tmp_path):
    spec = SP.merge([FRAGS[ctl]] + ([FRAGS[arm]] if arm else []))
    files, profiles = surface_files()
    want_files, want_profiles, _ = SP.apply_surface(files, profiles, spec["edits"])
    r, root = run_node(spec, tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    out = json.loads(r.stdout)
    assert out["ok"] and out["spec"] == spec["sha256"]
    g = root / ".gnomon"
    for n in SP.FILES:
        assert (g / n).read_text(encoding="utf-8") == want_files[n], n
    for n, t in want_profiles.items():
        assert (g / "profiles" / n).read_text(encoding="utf-8") == t, n
    for n in SP.FILES:  # still valid TOML, and the declared values are what a TOML reader sees
        tomllib.loads((g / n).read_text(encoding="utf-8"))
    for e in spec["edits"]:
        doc = tomllib.loads((g / e["file"]).read_text(encoding="utf-8"))
        cur = doc
        for part in e["table"].split("."):
            cur = cur.get(part, {})
        if e["op"] == "set":
            assert json.dumps(cur.get(e["key"])) == json.dumps(tomllib.loads(f"x = {e['literal']}")["x"])


@pytest.mark.parametrize("ctl,arm", combos())
def test_surface_diff_is_exactly_the_declared_edits(ctl, arm):
    spec = SP.merge([FRAGS[ctl]] + ([FRAGS[arm]] if arm else []))
    files, profiles = surface_files()
    new, newp, acts = SP.apply_surface(files, profiles, spec["edits"])
    changed = 0
    for n in SP.FILES:
        a, b = files[n].splitlines(), new[n].splitlines()
        changed += sum(1 for x in b if x not in a) + sum(1 for x in a if x not in b and not x.strip() == "")
    sets = [e for e in spec["edits"] if e["op"] == "set"]
    assert len(acts) >= len(spec["edits"])
    # every set line appears exactly once in the new surface, nowhere before (or replaced a line)
    for e in sets:
        line = f"{e['key']} = {e['literal']}"
        assert new[e["file"]].splitlines().count(line) == 1


def test_profile_propagation_for_role_tables():
    files, profiles = surface_files()
    spec = SP.merge([FRAGS["CTL.A"], FRAGS["PG"]])
    _, newp, acts = SP.apply_surface(files, profiles, spec["edits"])
    assert 'model = "glm-5.3"' in newp["local_first.toml"]            # the profile would override roles.toml
    assert "sampling" not in newp["local_first.toml"]                 # the profile does not declare it: untouched
    spec = SP.merge([FRAGS["CTL.A"], FRAGS["EL"]])
    _, newp, _ = SP.apply_surface(files, profiles, spec["edits"])
    assert newp == profiles                                           # no [roles.implementor] in the profile


def test_conflicting_fragments_are_refused():
    a = SP.Fragment(id="X", path="x", family="f", level="", status="ready", branches=["A"],
                    edits=[{"file": "config.toml", "table": "turn", "key": "k", "op": "set", "literal": "1"}])
    b = SP.Fragment(id="Y", path="y", family="g", level="", status="ready", branches=["A"],
                    edits=[{"file": "config.toml", "table": "turn", "key": "k", "op": "set", "literal": "2"}])
    with pytest.raises(SP.FragmentError):
        SP.merge([a, b])
    assert SP.merge([a, a])["edits"] == a.edits                        # identical edits deduplicate
    # the real mutually exclusive levels conflict: one family, one key
    with pytest.raises(SP.FragmentError):
        SP.merge([FRAGS["GC"], FRAGS["GR"]])
    with pytest.raises(SP.FragmentError):
        SP.merge([FRAGS["EL"], FRAGS["EM"]])


def test_multiline_value_and_duplicate_table_are_refused(tmp_path):
    files, profiles = surface_files()
    e = {"file": "roles.toml", "table": "roles.implementor", "key": "bash_deny", "op": "set", "literal": "[]"}
    with pytest.raises(SP.FragmentError):
        SP.apply_text(files["roles.toml"], [e])
    spec = {"edits": [e], "sha256": "t"}
    r, _ = run_node(spec, tmp_path)
    assert r.returncode == 3 and not json.loads(r.stdout)["ok"]
    with pytest.raises(SP.FragmentError):
        SP.apply_text("[a]\nx = 1\n[a]\ny = 2\n", [{"file": "config.toml", "table": "a", "key": "x", "op": "set",
                                                   "literal": "3"}])


def test_set_insert_replace_append_and_delete():
    t = "# head\n[a]\nx = 1 # note\n\n[[arr]]\nq = 1\n[b]\ny = 2\n"
    out, acts = SP.apply_text(t, [
        {"file": "c", "table": "a", "key": "x", "op": "set", "literal": "5"},
        {"file": "c", "table": "b", "key": "z", "op": "set", "literal": '"s"'},
        {"file": "c", "table": "c", "key": "w", "op": "set", "literal": "true"},
        {"file": "c", "table": "b", "key": "y", "op": "delete"},
        {"file": "c", "table": "b", "key": "nope", "op": "delete"},
    ])
    assert [a["action"] for a in acts] == ["replaced", "inserted", "table-added", "deleted", "absent"]
    doc = tomllib.loads(out)
    assert doc["a"]["x"] == 5 and doc["b"] == {"z": "s"} and doc["c"]["w"] is True and doc["arr"] == [{"q": 1}]


def test_policy_verify_table_is_added_when_absent():
    files, profiles = surface_files()
    assert "verify" not in tomllib.loads(files["policy.toml"])   # only commented-out examples in the scaffold
    new, _, acts = SP.apply_surface(files, profiles, SP.merge([FRAGS["GC"]])["edits"])
    assert tomllib.loads(new["policy.toml"])["verify"]["completion_gate"] == "checklist"
    assert acts[0]["action"] == "table-added"


def test_spec_hash_and_run_script():
    spec = SP.merge([FRAGS["CTL.B"], FRAGS["D"]])
    assert spec["sha256"] == SP.spec_hash(spec) and spec["task_args"] == ["--deadline", "1740"]
    s = SP.run_script(spec, "Do it; don't break 'quotes'.", P2G_PATCH)
    assert "--role implementor --deadline 1740 --yes --json" in s
    assert "as1-patch-failed.txt; exit 3" in s and "gnomon init" in s and s.rstrip().endswith("exit 0")
    assert SP.compile_js(spec) in __import__("shlex").split(s.split("node -e ", 2)[2])[0]
    p = SP.merge([FRAGS["CTL.A"], FRAGS["PK"]])
    assert "--role plan" in SP.run_script(p, "x", P2G_PATCH)
    bash = subprocess.run(["bash", "-n", "-c", s], capture_output=True, text=True)
    assert bash.returncode == 0, bash.stderr


def test_check_cell_semantics(tmp_path):
    agent, wire = tmp_path / "agent", tmp_path / "wire"
    agent.mkdir(), wire.mkdir()
    (agent / "gnomon-task.json").write_text(json.dumps({"counters": {"completion_gate": {"mode": "checklist"},
                                                                     "model_calls": {"window": 65536}}}))
    (agent / "surface-policy.toml").write_text('[verify]\ncompletion_gate = "checklist"\n')
    for i, body in enumerate([{"model": "m", "reasoning_effort": "low"}, {"model": "m", "temperature": 0.3}], 1):
        (wire / f"req-{i:04d}.json.gz").write_bytes(gzip.compress(json.dumps(body).encode()))
    ex = [{"on": "record", "path": "counters.completion_gate.mode", "op": "equals", "value": "checklist"},
          {"on": "record", "path": "counters.model_calls.window", "op": "equals", "value": 1000000},
          {"on": "surface", "path": "policy.toml:verify.completion_gate", "op": "equals", "value": "checklist"},
          {"on": "wire", "path": "reasoning_effort", "op": "equals", "value": "low", "quantifier": "any"},
          {"on": "wire", "path": "temperature", "op": "not_equals", "value": 0.3, "quantifier": "all"},
          {"on": "record", "path": "counters.x", "op": "present", "severity": "warn"}]
    res = [r["result"] for r in SP.check_cell(ex, agent, wire)]
    assert res == ["pass", "fail", "pass", "pass", "fail", "fail"]
    failed = SP.mechanism_failed(SP.check_cell(ex, agent, wire))
    assert [f["path"] for f in failed] == ["counters.model_calls.window", "temperature"]   # the warn is not fatal
    (agent / "gnomon-task.json").unlink()                                                  # a capped cell: no record
    assert SP.check_cell(ex[:1], agent, wire)[0]["result"] == "unverifiable"

# ------------------------------------------------------------------ run_as1 scoring (PRE-REGISTRATION §3)


@pytest.fixture()
def R(tmp_path, monkeypatch):
    import run_as1 as R
    monkeypatch.setattr(R, "OUT", tmp_path / "runs")
    monkeypatch.setattr(R, "JOBS", tmp_path / "jobs")
    monkeypatch.setattr(R, "OUTCOMES", tmp_path / "outcomes.jsonl")
    monkeypatch.setattr(R, "ROOT", tmp_path)
    return R


BUILD = {"version": "0.4.3", "commit": "abcdef0123456789" + "0" * 24}


def make_cell(R, cid, *, reward=0.0, exc=None, passed=3, tests=4, stop="answered", agent_s=900, usage=5,
              version="gnomon v0.4.3 abcdef0123456789 ffff", patch_failed=False, record=None):
    d, j = R.OUT / cid, R.JOBS / cid / "trial__x"
    (j / "agent").mkdir(parents=True), (j / "verifier").mkdir(parents=True), d.mkdir(parents=True)
    t0 = "2026-11-07T00:00:00Z"
    t1 = f"2026-11-07T00:{agent_s // 60:02d}:{agent_s % 60:02d}Z" if agent_s < 3600 else "2026-11-07T01:00:00Z"
    (j / "result.json").write_text(json.dumps({"verifier_result": {"rewards": {"reward": reward}} if reward is not None else None,
                                               "exception_info": {"exception_type": exc} if exc else None,
                                               "agent_info": {"version": version},
                                               "agent_execution": {"started_at": t0, "finished_at": t1}}))
    if tests:
        (j / "verifier" / "ctrf.json").write_text(json.dumps({"results": {"summary": {"passed": passed, "tests": tests}}}))
    rec = record if record is not None else {"stop_reason": stop, "counters": {"completion_gate": {"mode": "checklist"}}}
    (j / "agent" / "gnomon-task.json").write_text(json.dumps(rec))
    if patch_failed:
        (j / "agent" / "as1-patch-failed.txt").write_text("x")
    (d / "cell.json").write_text(json.dumps({"task": "t", "slot": 0, "delta": {"responses_with_usage": usage},
                                             "trial": R.trial_of(R.JOBS / cid), "wire_spend_usd": 0.2,
                                             "spec_sha256": "s"}))


def member(expects=()):
    return {"label": "GC", "kind": "gnomon", "spec": {"fragments": ["CTL.A", "GC"], "expects": list(expects), "sha256": "s"}}


WAVE = {"round": 0, "id": "s00w00"}


def test_score_rules(R):
    make_cell(R, "ok")
    o = R.score("ok", member(), BUILD, "screen", WAVE)
    assert o["valid"] and o["frac"] == 0.75 and o["ff"] and not o["capped"] and not o["solved"]
    make_cell(R, "late", agent_s=1600)            # self-ended wrong with < 300 s left: not a false finish
    assert not R.score("late", member(), BUILD, "screen", WAVE)["ff"]
    make_cell(R, "cap", exc="AgentTimeoutError", agent_s=1800, record={})
    o = R.score("cap", member(), BUILD, "screen", WAVE)
    assert o["valid"] and o["capped"] and not o["ff"]
    make_cell(R, "dl", stop="deadline", agent_s=1710)   # a --deadline self-stop counts as capped
    o = R.score("dl", member(), BUILD, "screen", WAVE)
    assert o["capped"] and not o["harbor_timeout"] and not o["ff"]
    make_cell(R, "solved", reward=1.0, passed=4)
    assert R.score("solved", member(), BUILD, "screen", WAVE)["solved"]
    make_cell(R, "step", stop="step_wall")               # ended by the step wall: wrong, not a false finish
    assert not R.score("step", member(), BUILD, "screen", WAVE)["ff"]


def test_score_invalid_reasons(R):
    make_cell(R, "noreward", reward=None, exc="RuntimeError")
    assert R.score("noreward", member(), BUILD, "screen", WAVE)["invalid_reason"].startswith("no verifier reward")
    make_cell(R, "nousage", usage=0)
    assert R.score("nousage", member(), BUILD, "screen", WAVE)["invalid_reason"] == "no model response with usage"
    make_cell(R, "patch", patch_failed=True)
    assert R.score("patch", member(), BUILD, "screen", WAVE)["invalid_reason"] == "surface patch refused"
    make_cell(R, "pin", version="gnomon v0.4.2 2498d16dc248bc18 fc42")
    assert R.score("pin", member(), BUILD, "screen", WAVE)["invalid_reason"].startswith("build pin")
    make_cell(R, "mech")
    m = member([{"on": "record", "path": "counters.completion_gate.mode", "op": "equals", "value": "review", "arm": "GR"}])
    assert R.score("mech", m, BUILD, "screen", WAVE)["invalid_reason"].startswith("mechanism")
    make_cell(R, "oc", record={})
    o = R.score("oc", {"label": "O", "kind": "opencode"}, None, "confirm", WAVE)
    assert o["valid"] and o["ff"]                         # opencode: self-ended wrong early is a false finish


def test_pairs_and_reruns(R):
    outs = []

    def o(wave, label, valid=True, frac=0.5, cap=False):
        outs.append({"cell": f"{wave}-{label}", "stage": "screen", "round": 0, "wave": wave, "label": label, "task": "t",
                     "valid": valid, "frac": frac, "capped": cap, "ff": False, "solved": False, "usd": 0.2})
    o("s00w00", "CTL"), o("s00w00", "GC", frac=0.75), o("s00w00", "GR", valid=False)
    o("s00w01", "CTL", valid=False), o("s00w01", "D"), o("s00w01", "W")
    ps = R.pairs_from(outs)
    assert [(p.arm, p.d) for p in ps] == [("GC", 0.25)]   # never paired across waves
    R.OUTCOMES.write_text("".join(json.dumps(x) + "\n" for x in outs))
    rr = R.reruns([{"id": "s00w00", "task": "t", "arms": ["GC", "GR"]}, {"id": "s00w01", "task": "t", "arms": ["D", "W"]}],
                  "screen")
    assert [(w["id"], w["lost"]) for w in rr] == [("s00w00r", ["GR"]), ("s00w01r", ["D", "W"])]
    o("s00w00r", "CTL", frac=0.25), o("s00w00r", "GR", frac=0.5)
    assert ("GR", 0.25) in [(p.arm, p.d) for p in R.pairs_from(outs)]


def test_dry_plans_both_branches(R, capsys):
    import argparse
    import run_as1
    text = run_as1.dry(argparse.Namespace(branch=None, start="2026-11-07T00:00Z", budget=None))
    assert "=== branch A: control CTL.A" in text and "=== branch B: control CTL.B" in text and text.endswith("DRY OK")
    assert "=== branch C: control CTL.C" in text
    lean = run_as1.dry(argparse.Namespace(branch="A", start=None, budget="lean"))
    assert "confirmatory k = 2" in lean
    run_as1.use_budget("recommended")


def test_amendment1_branch_c_and_gcd():
    """Amendment 1: branch C runs every ready arm except the excluded EDIT; GCD = GC's edit + D's deadline, and
    subsumes the deadline family in stage I."""
    import run_as1
    knobs = ["replay_default", "deadline", "completion_gate", "reasoning_effort", "sampling_passthrough",
             "env_snapshot", "todo_gate", "edit_variant", "package_index_allowlist", "steer_role"]
    ctl, arms, excluded = run_as1.eligible("C", knobs)
    assert ctl.id == "CTL.C"
    assert sorted(arms) == ["AA", "D", "EH", "EL", "EM", "ENV", "GC", "GCD", "GR", "PKG", "S", "TODO", "W"]
    assert "EDIT" in excluded
    with pytest.raises(SystemExit):
        run_as1.eligible("A", knobs)  # CTL.A needs nudge_default_off, which v0.4.4 does not ship
    sp = SP.merge([ctl, FRAGS["GCD"], FRAGS["D"]])
    assert sp["task_args"] == ["--deadline", "1740"]
    assert SP.merge([ctl, FRAGS["GCD"]])["edits"] == SP.merge([ctl, FRAGS["GC"]])["edits"]
    cands = [{"family": "completion_gate", "arm": "GCD", "why": "promoted"},
             {"family": "deadline", "arm": "D", "why": "promoted"}, {"family": "window", "arm": "W", "why": "near-promoted"}]
    assert [c["arm"] for c in run_as1.subsumed_out(cands, FRAGS)] == ["GCD", "W"]
    cands[0]["arm"] = "GC"
    assert [c["arm"] for c in run_as1.subsumed_out(cands, FRAGS)] == ["GC", "D", "W"]


def test_arm_expectation_overrides_control_on_same_path():
    sp = SP.merge([FRAGS["CTL.C"], FRAGS["W"]])
    win = [x for x in sp["expects"] if x["path"] == "counters.model_calls.window"]
    assert len(win) == 1 and win[0]["value"] == 1000000 and win[0]["arm"] == "W"
    assert any(x["path"] == "config.toml:turn.nudge_after_idle" and x["arm"] == "CTL.C" for x in sp["expects"])
    assert SP.merge([FRAGS["CTL.C"], FRAGS["ENV"]])["task_args"] == ["--trust"]
