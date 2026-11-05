#!/usr/bin/env python3
"""GBS-AUDIT 0.2 (draft): the tamper corpus (AUDITABILITY.md §4) against opencode v2.2.5's own session
store, inside the gbs05 container (--network none).

usage: audit_oc.py <outdir>     writes <outdir>/audit-opencode.json and <outdir>/trails/

1. Real trails (§6.1): three sessions of different shapes, written by the pinned build itself, driven
   by a scripted model (AUDIT-1: the driver is stated). Each ends normally (exit 0).
2. The unit is a session (one `session_v2` row); a record is one `session_message` row with its
   `session_part` rows. opencode's store is SQLite: ~/.local/share/opencode/opencode.db.
3. The mutation adapter (§6.2) is below: load/save over SQL; `rehash` is absent (no record carries an
   integrity value); `anchor_state` is empty (nothing is anchored).
4. The verifier (§6.3): opencode documents none. Every case is scored "undetected, no verifier".
   Diagnostic only, never a score: after each mutation, `opencode session export <id>` (documented,
   run as a user runs it) and `opencode session list`, to show what opencode then presents.
"""
import hashlib, json, os, shutil, sqlite3, subprocess, sys, tempfile, time
from pathlib import Path

APP = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
GOV = APP.parent / "governance"
W = Path(tempfile.mkdtemp(prefix="gbs-audit-"))
HOME, WS = W / "home", W / "ws"
EXPECT = "opencode v2.2.5"


def sh(cmd, cwd, env, timeout=120):
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)


ENV = {"PATH": os.environ["PATH"], "HOME": str(HOME), "LANG": "C.UTF-8", "OPENCODE_DISABLE_AUTOUPDATE": "1", "PWD": str(WS),
       "OPENCODE_CONFIG": str(WS / "opencode.json"), "GIT_AUTHOR_NAME": "Dev", "GIT_AUTHOR_EMAIL": "dev@example.invalid",
       "GIT_COMMITTER_NAME": "Dev", "GIT_COMMITTER_EMAIL": "dev@example.invalid"}
DB = HOME / ".local/share/opencode/opencode.db"

# ── the sessions (scripted model: governance/fake_model.py, a plan per session) ──
B = lambda c: {"tool": "shell", "args": {"command": c}}
R = lambda p: {"tool": "read", "args": {"path": p}}
E = lambda p, o, n: {"tool": "edit", "args": {"path": p, "oldString": o, "newString": n}}
Wr = lambda p, c: {"tool": "write", "args": {"path": p, "content": c}}
SESSIONS = [
    ("AUDIT-S1 fix add()", [R("src/calc.py"), E("src/calc.py", "return a - b", "return a + b"), B("python3 -m pytest -q -p no:cacheprovider"), R("README.md"), B("git diff --stat")]),
    ("AUDIT-S2 notes", [R("README.md"), Wr("docs/NOTES.md", "# Notes\n\nadd() fixed.\n"), B("ls docs"), R("docs/NOTES.md"), E("docs/NOTES.md", "fixed", "fixed and tested"), B("git status --short"), R("src/calc.py")]),
    ("AUDIT-S3 tidy", [B("ls -la"), R(".gitignore"), Wr("docs/CHANGES.md", "- add() now adds\n"), B("cat docs/CHANGES.md"), R("tests/test_calc.py"), B("python3 -m pytest -q -p no:cacheprovider")]),
]


def setup():
    for d in (HOME, WS):
        d.mkdir(parents=True)
    (WS / "src").mkdir(); (WS / "tests").mkdir(); (WS / "docs").mkdir()
    (WS / "src/calc.py").write_text("# calc\n\n\ndef add(a, b):\n    return a - b\n")
    (WS / "tests/test_calc.py").write_text("import os, sys\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n")
    (WS / "README.md").write_text("# calc\n")
    (WS / ".gitignore").write_text("__pycache__/\n.pytest_cache/\n")
    sh(["git", "init", "-q", "-b", "main"], WS, ENV); sh(["git", "add", "-A"], WS, ENV); sh(["git", "commit", "-qm", "fixture"], WS, ENV)


def run_sessions():
    plan, log = W / "plan.json", W / "fake.jsonl"
    plan.write_text("{}")
    fm = subprocess.Popen([sys.executable, "-I", str(GOV / "fake_model.py"), str(plan), str(log)], stdout=subprocess.PIPE, text=True)
    port = int(fm.stdout.readline())
    cfg = {"$schema": "https://opencode.ai/config.json", "model": {"providerID": "gbs", "model": "fake"}, "update": "disable", "share": "disabled",
           "providers": {"gbs": {"name": "gbs fake", "package": "aisdk:@ai-sdk/openai-compatible",
                                 "settings": {"apiKey": "none", "baseURL": "http://127.0.0.1:%d/v1" % port}, "models": {"fake": {"name": "fake"}}}}}
    (WS / "opencode.json").write_text(json.dumps(cfg, indent=2) + "\n")
    runs, snaps = [], []
    try:
        for i, (title, calls) in enumerate(SESSIONS):
            plan.write_text(json.dumps({"first": calls[0], "post": calls[1:]}))
            r = sh(["opencode", "run", "--standalone", "--title", title, "Do the scripted steps, then say done."], WS, ENV)
            runs.append({"title": title, "exit": r.returncode, "steps": len(calls), "stderr_tail": r.stderr[-200:]})
            snap = W / ("store-after-session-%d" % (i + 1))
            shutil.copytree(DB.parent, snap, ignore=shutil.ignore_patterns("snapshot", "log", "repos", "shell"))
            snaps.append(snap)
    finally:
        fm.terminate()
    return runs, snaps, cfg


# ── the mutation adapter (§6.2) ──
def con(db=DB):
    c = sqlite3.connect(str(db), timeout=10); c.row_factory = sqlite3.Row
    return c


def units(db=DB):
    with con(db) as c:
        return [dict(r) for r in c.execute("select id, title from session_v2 where parent_id is null order by rowid")]


def load(sid, db=DB):
    with con(db) as c:
        msgs = [dict(r) for r in c.execute("select * from session_message where session_id=? order by seq", (sid,))]
        for m in msgs:
            m["parts"] = [dict(p) for p in c.execute("select * from session_part where message_id=? order by ordinal", (m["id"],))]
    return msgs


def unit_digest(sid, db=DB):
    h = hashlib.sha256()
    for m in load(sid, db):
        h.update(json.dumps({k: m[k] for k in ("id", "seq", "type", "data")}, sort_keys=True).encode())
        for p in m["parts"]:
            h.update(json.dumps({k: p[k] for k in ("ordinal", "type", "data")}, sort_keys=True).encode())
    return h.hexdigest()


def forge_string(d, path=""):
    """Append a marker to the first text-bearing string in a record (text, output, stdout), depth first."""
    if isinstance(d, dict):
        for k in ("text", "output", "stdout"):
            if isinstance(d.get(k), str) and d[k]:
                d[k] = d[k] + " [FORGED]"
                return path + "." + k
        for k, v in d.items():
            r = forge_string(v, path + "." + k)
            if r:
                return r
    if isinstance(d, list):
        for i, v in enumerate(d):
            r = forge_string(v, "%s[%d]" % (path, i))
            if r:
                return r
    return None


def case_E1(sid):
    """opencode 2.2.5 keeps a record's content in session_message.data (session_part is empty), so E1
    edits one text-bearing field of a middle record there."""
    msgs = load(sid)
    order = msgs[len(msgs) // 2:] + msgs[:len(msgs) // 2]
    for m in order:
        d = json.loads(m["data"])
        path = forge_string(d)
        if path:
            with con() as c:
                c.execute("update session_message set data=? where id=?", (json.dumps(d), m["id"]))
            return {"message": m["id"], "seq": m["seq"], "type": m["type"], "field": path}
    raise RuntimeError("no text-bearing record")


def case_I1(sid, middle=False):
    msgs = load(sid); src = msgs[-1]
    with con() as c:
        if middle:  # I2: a record inserted between two others (seq shifted up to make room)
            at = msgs[len(msgs) // 2]["seq"]
            for m in sorted(msgs, key=lambda m: -m["seq"]):
                if m["seq"] >= at:
                    c.execute("update session_message set seq=? where id=?", (m["seq"] + 1, m["id"]))
            seq = at
        else:
            seq = max(m["seq"] for m in msgs) + 1
        nid = src["id"][:-6] + "FORGED"
        c.execute("insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?,?,?,?,?,?,?)",
                  (nid, sid, src["type"], seq, src["time_created"] + 1, src["time_updated"] + 1, src["data"]))
        for p in src["parts"]:
            c.execute("insert into session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) values (?,?,?,?,?,?,?,?)",
                      (nid, sid, p["ordinal"], p["type"], p["call_id"], p["time_created"] + 1, p["time_updated"] + 1, p["data"].replace(src["id"], nid)))
    return {"inserted": nid, "seq": seq}


def case_D1(sid):
    msgs = load(sid); m = msgs[len(msgs) // 2]
    with con() as c:
        c.execute("delete from session_part where message_id=?", (m["id"],)); c.execute("delete from session_message where id=?", (m["id"],))
    return {"deleted": m["id"], "seq": m["seq"]}


def case_D2(sid):
    with con() as c:
        c.execute("pragma foreign_keys=on")
        c.execute("delete from session_part where session_id=?", (sid,)); c.execute("delete from session_message where session_id=?", (sid,))
        c.execute("delete from session_v2 where id=?", (sid,))
    return {"deleted_unit": sid}


def case_T1(sid):
    msgs = load(sid); gone = msgs[-2:]
    with con() as c:
        for m in gone:
            c.execute("delete from session_part where message_id=?", (m["id"],)); c.execute("delete from session_message where id=?", (m["id"],))
    return {"truncated": [m["seq"] for m in gone]}


def case_O1(sid):
    msgs = load(sid); a, b = msgs[1], msgs[2]
    with con() as c:
        c.execute("update session_message set seq=-1 where id=?", (a["id"],))
        c.execute("update session_message set seq=? where id=?", (a["seq"], b["id"]))
        c.execute("update session_message set seq=? where id=?", (b["seq"], a["id"]))
    return {"swapped": [a["seq"], b["seq"]]}


CASES = [  # (id, level, fn or None, note)  — §4, with the format's N/A cases named
    ("E1", "A1", case_E1, "a field of a middle record changed"),
    ("E2", "A2", None, "N/A: no record carries an integrity value, so E2 is E1"),
    ("E3", "A1", None, "N/A: no integrity value to remove"),
    ("I1", "A2", lambda s: case_I1(s, False), "a forged record appended (copy of the last, new id)"),
    ("I2", "A1", lambda s: case_I1(s, True), "a record inserted in the middle"),
    ("D1", "A1", case_D1, "a middle record deleted"),
    ("D2", "A1", case_D2, "the whole unit (session) deleted"),
    ("D3", "A3", None, "N/A: no integrity evidence (signatures, heads, receipts) exists"),
    ("T1", "A1", case_T1, "the last two records removed"),
    ("O1", "A1", case_O1, "two records swapped"),
    ("R1", "A2", None, "N/A: no chain, so R1 is E1"),
    ("R2", "A3", None, "N/A: no anchor state"),
    ("C1", "A3", None, "N/A: no anchor, so no claimed time to move"),
    ("K1", "A3", None, "N/A: opencode does not sign"),
    ("K2", "A3", None, "N/A: opencode does not anchor"),
    ("B1", "A3", "rollback", "the whole store restored to its state after session 2 (session 3 vanishes)"),
]


def diagnostics(sid):
    ex = sh(["opencode", "session", "export", "--standalone", sid], WS, ENV)
    ls = sh(["opencode", "session", "list", "--standalone", "--format", "json"], WS, ENV)
    out = ex.stdout or ""
    return {"export_exit": ex.returncode, "export_bytes": len(out), "export_has_FORGED": ("FORGED" in out),
            "export_stderr": (ex.stderr or "")[-200:], "list_exit": ls.returncode, "list_has_unit": sid in (ls.stdout or "")}


def main():
    v = subprocess.run(["opencode", "--version"], capture_output=True, text=True).stdout.strip()
    assert v == EXPECT, v
    setup()
    runs, snaps, cfg = run_sessions()
    assert all(r["exit"] == 0 for r in runs), runs
    us = units()
    shapes = [{"unit": u["id"], "title": u["title"], "records": len(load(u["id"])), "parts": sum(len(m["parts"]) for m in load(u["id"]))} for u in us]
    assert len(us) == 3 and all(s["records"] >= 6 for s in shapes), shapes
    control = W / "control-store"
    shutil.copytree(DB.parent, control, ignore=shutil.ignore_patterns("snapshot", "log", "repos", "shell"))
    for i, u in enumerate(us):  # publish the control trails (the export a user would see)
        (OUT / "trails").mkdir(exist_ok=True)
        (OUT / "trails" / ("control-session-%d.json" % (i + 1))).write_text(sh(["opencode", "session", "export", "--standalone", u["id"]], WS, ENV).stdout)
    target = us[1]["id"]  # session 2, as in the 0.1 apparatus
    ctl = diagnostics(target)
    results = []
    for cid, level, fn, note in CASES:
        # fresh copy of the control store for every case
        shutil.rmtree(DB.parent); shutil.copytree(control, DB.parent)
        before = {u["id"]: unit_digest(u["id"]) for u in units()}
        if fn is None:
            results.append({"case": cid, "level": level, "status": "N/A", "note": note})
            continue
        if fn == "rollback":
            shutil.rmtree(DB.parent); shutil.copytree(snaps[1], DB.parent); detail = {"restored": "store after session 2"}
            affected = [us[2]["id"]]
        else:
            detail = fn(target); affected = [target]
        after = {u["id"]: unit_digest(u["id"]) for u in units()}
        changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
        diag = diagnostics(affected[0])
        results.append({"case": cid, "level": level, "status": "run", "note": note, "detail": detail, "affected_unit": affected,
                        "mutation_took_effect": bool(changed), "units_changed": changed,
                        "verifier": None, "detected": False, "score": "undetected, no verifier", "diagnostic": diag})
    shutil.rmtree(DB.parent); shutil.copytree(control, DB.parent)
    by_level = {}
    for r in results:
        if r["status"] != "run":
            continue
        L = by_level.setdefault(r["level"], {"run": 0, "detected": 0, "na": 0})
        L["run"] += 1
    for r in results:
        if r["status"] == "N/A":
            by_level.setdefault(r["level"], {"run": 0, "detected": 0, "na": 0})["na"] += 1
    card = {"spec": "GBS-AUDIT 0.2 (draft)", "level": "harness", "harness": v, "store": "SQLite ~/.local/share/opencode/opencode.db (session_v2, session_message, session_part)",
            "unit": "session", "record": "session_message row with its session_part rows", "integrity_field": None,
            "verifier": "none documented (opencode v2.2.5 `--help`, `session --help`: list, delete, export, import)",
            "driver": "scripted model (governance/fake_model.py), AUDIT-1", "sessions": runs, "shapes": shapes,
            "control": {"verifier": "n/a (no verifier)", "export_of_target": ctl}, "target_unit": target,
            "cases": results, "by_level": by_level, "witness": "none (opencode anchors nothing)",
            "false_positives": "n/a: no verifier, so no verdict to be wrong",
            "finished_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "opencode_config": cfg}
    (OUT / "audit-opencode.json").write_text(json.dumps(card, indent=1) + "\n")
    print(json.dumps({"shapes": shapes, "by_level": by_level, "export_reflects_forgery": [r["case"] for r in results if r.get("diagnostic", {}).get("export_has_FORGED")]}))


if __name__ == "__main__":
    main()
