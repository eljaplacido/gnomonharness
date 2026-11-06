"""FG1 pre-launch wire test (from AS1's wiretest_as1.py): every arm's REAL cell script against the PINNED build and a
fake model on the docker bridge. Its output is committed as ../wiretest-fg1.txt and its sha256 goes into build.toml
(`wiretest`), which run_fg1.py check requires.

    python3 wiretest_fg1.py <npm prefix with the pinned build installed> <empty work dir> [--arms C,FG,SH]

No Harbor, no Docker, no paid model, no real key: the script is surface_patch.run_script (exactly what GnomonFG1.run
hands to Harbor), run with bash on this host in an EMPTY HOME/XDG (a stranger's state: no trust store, no
credentials), /logs/agent mapped to a local dir. The fake model listens on 172.17.0.1 (a non-loopback private address,
as the cells' log relays are; the test refuses to run on loopback, which would not exercise the v0.4.5 key grant). It
records each request's Authorization CLASS (placeholder / absent / other) and writes calls.jsonl in log-relay.mjs's
format, so fg1_checks.cell_checks runs on it exactly as on a real cell.

The fake's script, per run: request 1 -> reasoning + bash `sleep 33; echo ... >> wiretest.txt` (past SH's 30 s yield,
inside C's 120 s timeout); a request whose last tool result names a running job j1 (only possible under SH) ->
`job wait j1`; other odd requests -> reasoning + a short bash; even requests -> reasoning + an answer containing a
caveat ("One judgement call worth flagging: ...") so FG's caveat audit has something to quote; after 12 requests,
answers only. Expected: C answers at request 2; FG is handed back at 2 and accepted at 4; SH yields at 30 s, waits, and
answers at 4.

Checks, per arm:
  - the local build carries build.toml's gnomonBuild and `gnomon --version` pins;
  - the script exits 0, gnomon exits 0, the patch reports ok with the spec's hash, no fg1-patch-failed.txt;
  - surface = the control's run + exactly the arm's edits (Python reference implementation);
  - every FATAL fragment expectation passes ('unverifiable' fails here: the fake run must produce what cells are
    checked against) and every FATAL fg1_checks check passes, i.e. key on every request, trust grant, job tool
    offered only in SH, `job` yield audited in SH and absent elsewhere, no finish_gate record outside FG, replay;
  - FG: request 3 carries a user-role "[gnomon] " hand-back after the rejected answer and the record's finish_gate
    rounds >= 1; C and SH: no such message;
  - SH: >= 1 `job` yield in the audit and a `job` call on the wire; C/FG: none.
Plus two runs of the control:
  - NEGATIVE CONTROL: the same script without the trust grant. The key must NOT reach the fake (auth absent) or the
    run must be clamped: proves the `key` check can fail, i.e. that a pass above is evidence;
  - a read-only working directory: gnomon falls back to the state directory, the patch and the grant find it.
Amendment 1 (--slots 3,4,5): plus the LIVE path of each relay slot FG1 now uses (log relay 4740+slot -> slot relay
4710+slot -> OpenCode Go), one tiny real request per slot with the placeholder key; see live_slots().
"""
import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent.parent / "p2g-2026-11" / "apparatus")]
import fg1_checks as FC  # noqa: E402
import surface_patch as SP  # noqa: E402

MODEL = "deepseek-v4.1-flash"
PLACEHOLDER = "p2g-relay-placeholder"
J = json.dumps
ok_all = True
LINES: list[str] = []


def say(s: str) -> None:
    LINES.append(s)
    print(s, flush=True)


def check(cond, what: str) -> None:
    global ok_all
    say(f"  {'ok  ' if cond else 'FAIL'} {what}")
    ok_all = ok_all and bool(cond)


def _content(m) -> str:
    c = m.get("content")
    return c if isinstance(c, str) else J(c)


class Fake(BaseHTTPRequestHandler):
    n = 0
    bodies: list = []
    rows: list = []
    waited = False

    def log_message(self, *a):
        pass

    def do_GET(self):  # a /models listing behind the relay answers 404, as Go's does
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        h = self.headers.get("authorization")
        auth = "absent" if not h else ("placeholder" if h == f"Bearer {PLACEHOLDER}" else "other")
        Fake.bodies.append(body)
        Fake.n += 1
        n = Fake.n
        msgs = body.get("messages") or []
        tools = [t.get("function", {}).get("name") for t in body.get("tools") or []]
        last = msgs[-1] if msgs else {}
        rc = f"WIRETEST-REASONING-{n}"
        if last.get("role") == "tool" and "job" in tools and "j1" in _content(last) and not Fake.waited:
            Fake.waited = True
            call = ("job", {"action": "wait", "id": "j1", "seconds": 30})
        elif n == 1:
            call = ("bash", {"command": "sleep 33; echo wiretest-1 >> wiretest.txt; ls -A"})
        elif n % 2 == 1 and n < 12:
            call = ("bash", {"command": f"echo wiretest-{n} >> wiretest.txt; cat wiretest.txt"})
        else:
            call = None
        if call:
            delta = {"role": "assistant", "reasoning_content": rc, "tool_calls": [{"index": 0, "id": f"call_{n}",
                     "type": "function", "function": {"name": call[0], "arguments": J(call[1])}}]}
            finish = "tool_calls"
        else:
            delta = {"role": "assistant", "reasoning_content": rc,
                     "content": "Done: wiretest.txt has the lines. One judgement call worth flagging: I kept the extra "
                                "line rather than removing it."}
            finish = "stop"
        usage = {"prompt_tokens": 100 + n, "completion_tokens": 10, "total_tokens": 110 + n}
        Fake.rows.append({"n": n, "auth": auth, "req": {
            "tools": tools, "n_messages": len(msgs), "roles": "".join((m.get("role") or "?")[0] for m in msgs),
            "assistant": sum(1 for m in msgs if m.get("role") == "assistant"),
            "assistant_with_reasoning": sum(1 for m in msgs if m.get("role") == "assistant"
                                            and (m.get("reasoning_content") or m.get("reasoning")))},
            "resp": {"reasoning_chars": len(rc), "tool_calls": [{"name": call[0]}] if call else [], "finish": finish}})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for chunk in ({"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                      {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}, {"choices": [], "usage": usage}):
            self.wfile.write(f"data: {J(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


GO_RATIO = 1.2  # allowance / list_cost on slot 0: all 955 AS1 calls to 2026-11-06T16:53Z and the A1 probe


def live_slots(slots: list[int], work: Path) -> None:
    """Amendment 1 (relay slots 3-5): the exact path a cell's requests take — FG1's log-relay.mjs on 4740+slot in
    front of the slot relay on 4710+slot (relay-go.mjs, which injects the key), to OpenCode Go — with the cell's
    placeholder key and a streamed request, one tiny prompt per slot. Checks: HTTP 200 and a usage-bearing reply,
    the log relay classed the key `placeholder`, the slot relay's counters moved by exactly one request with usage and
    no 4xx/5xx/error, billing_source go-plus and allowance / list_cost = GO_RATIO (slot 0's: no other price)."""
    import urllib.request
    say(f"\n== live slot path (Amendment 1): slots {slots}, one tiny streamed request each, placeholder key")
    for s in slots:
        port, up, cport = 4740 + s, 4710 + s, 4810 + s
        ctr = lambda: json.load(urllib.request.urlopen(f"http://127.0.0.1:{cport}/counters", timeout=10))  # noqa: E731
        wire = work / f"live-slot{s}"
        relay = subprocess.Popen(["node", str(HERE / "log-relay.mjs"), f"172.17.0.1:{port}", f"http://172.17.0.1:{up}",
                                  str(wire)], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                                 env={**os.environ, "FG1_KEY_PLACEHOLDER": PLACEHOLDER})
        time.sleep(1.5)
        status, usage = None, None
        try:
            before = ctr()
            body = {"model": MODEL, "stream": True, "stream_options": {"include_usage": True}, "temperature": 0,
                    "max_tokens": 16, "messages": [{"role": "user", "content": "Reply with exactly the word: ok"}]}
            req = urllib.request.Request(f"http://172.17.0.1:{port}/openai/v1/chat/completions", method="POST",
                                         data=J(body).encode(), headers={
                                             "content-type": "application/json", "authorization": f"Bearer {PLACEHOLDER}",
                                             "user-agent": "gnomon-fg1-wiretest/1", "x-opencode-session": f"fg1-wt-slot{s}"})
            with urllib.request.urlopen(req, timeout=120) as r:
                status, text = r.status, r.read().decode(errors="replace")
            for line in text.splitlines():
                if line.startswith("data:") and line.strip() != "data: [DONE]":
                    try:
                        o = json.loads(line[5:])
                    except Exception:
                        continue
                    usage = o.get("usage") or usage
            time.sleep(1)
            after = ctr()
        finally:
            relay.terminate()
            relay.wait(timeout=10)
        rows = [json.loads(l) for l in (wire / "calls.jsonl").read_text().splitlines() if l.strip()] \
            if (wire / "calls.jsonl").exists() else []
        d = {k: round(after[k] - before[k], 10) for k in ("chat_requests", "responses_with_usage", "status_4xx",
                                                          "status_5xx", "errors", "allowance")}
        oc = (usage or {}).get("opencode") or {}
        ratio = round(oc["allowance"] / oc["list_cost"], 3) if oc.get("list_cost") else None
        say(f"slot {s} (log relay {port} -> slot relay {up}): HTTP {status}, usage in {usage and usage.get('prompt_tokens')}"
            f" out {usage and usage.get('completion_tokens')}, billing {oc.get('billing_source')}, allowance "
            f"{oc.get('allowance')} / list {oc.get('list_cost')} = {ratio}; log-relay auth {[r.get('auth') for r in rows]};"
            f" counters delta {d}")
        check(status == 200 and usage is not None, f"slot {s}: HTTP 200 with usage")
        check([r.get("auth") for r in rows] == ["placeholder"], f"slot {s}: the log relay saw the placeholder key")
        check(d["chat_requests"] == 1 and d["responses_with_usage"] == 1 and not (d["status_4xx"] or d["status_5xx"]
              or d["errors"]), f"slot {s}: slot relay metered one request with usage, no 4xx/5xx/error")
        check(oc.get("billing_source") == "go-plus" and ratio == GO_RATIO,
              f"slot {s}: billed as slot 0 (go-plus, allowance/list = {GO_RATIO})")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("prefix")
    ap.add_argument("work")
    ap.add_argument("--arms", default="")
    ap.add_argument("--out", default=str(HERE.parent / "wiretest-fg1.txt"))
    ap.add_argument("--build", default=str(HERE / "build.toml"))
    ap.add_argument("--slots", default="", help="Amendment 1: also check the live path log relay -> slot relay -> Go "
                    "for these slots (one tiny real request each, the cell's placeholder key)")
    a = ap.parse_args()
    import tomllib
    from gnomon_harbor import _PATCH
    b = tomllib.loads(Path(a.build).read_text())["build"]
    prefix, work = Path(a.prefix).resolve(), Path(a.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    assert not any(work.iterdir()), f"{work} must be empty"
    stamp = json.loads((prefix / "lib/node_modules/gnomon-core/package.json").read_text())["gnomonBuild"]
    home = work / "home"
    xenv = {"PATH": f"{prefix / 'bin'}:{os.environ['PATH']}", "HOME": str(home), "XDG_DATA_HOME": str(home / "xdg"),
            "XDG_CONFIG_HOME": str(home / "xdgc"), "XDG_STATE_HOME": str(home / "state"), "NO_COLOR": "1",
            "LANG": "C.UTF-8"}
    (home / ".nvm").mkdir(parents=True)
    (home / ".nvm" / "nvm.sh").write_text("# wiretest stub: node and gnomon are on PATH\n")
    (home / ".gnomon-release").write_text(f"gnomon v{b['version']} {b['commit'][:16]} wiretest-local-prefix\n")
    ver = subprocess.run(["gnomon", "--version"], env=xenv, capture_output=True, text=True).stdout.strip().splitlines()[-1]
    say(f"== FG1 wire test: build {stamp}, `gnomon --version` = {ver}; build.toml {b['version']} {b['commit'][:12]} "
        f"({b['status']})")
    check(stamp == b["build_stamp"] and ver == f"gnomon/{b['version']}+{b['build_stamp']}", "local build = build.toml pins")
    host = "172.17.0.1"  # never loopback: the key grant only applies to a non-loopback address
    srv = ThreadingHTTPServer((host, 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://{host}:{srv.server_address[1]}/openai/v1"
    say(f"fake model at {base} (non-loopback private address, as the cells' relays)")
    run_env = {**xenv, "OPENAI_BASE_URL": base, "OPENAI_API_KEY": PLACEHOLDER,
               "GNOMON_BENCH_URL": f"{base}/chat/completions", "GNOMON_BENCH_MODEL": MODEL}
    frags = SP.load_all()
    ctl = frags["C"]
    want = [x for x in a.arms.split(",") if x] or ["FG", "SH"]
    cwd = work / "cwd"
    surfaces = {}

    def run(label, spec, readonly=False, grant=True):
        logs = work / f"logs-{label}{'-ro' if readonly else ''}{'' if grant else '-nogrant'}"
        logs.mkdir()
        shutil.rmtree(cwd, ignore_errors=True)
        cwd.mkdir()
        for d in ("state", "xdg"):  # a fresh store per run: no trust carried between arms
            shutil.rmtree(home / d, ignore_errors=True)
        if readonly:
            cwd.chmod(0o555)
        Fake.n, Fake.bodies, Fake.rows, Fake.waited = 0, [], [], False
        script = SP.run_script(spec, "Append a line to wiretest.txt, then stop.", _PATCH, trust_grant=grant) \
            .replace("/logs/agent", str(logs))
        t0 = time.time()
        p = subprocess.run(["bash", "-c", script], cwd=cwd, env=run_env, capture_output=True, text=True, timeout=900)
        wall = time.time() - t0
        if readonly:
            cwd.chmod(0o755)
        wire = logs / "wire"
        wire.mkdir()
        for i, body in enumerate(Fake.bodies, 1):
            (wire / f"req-{i:04d}.json.gz").write_bytes(gzip.compress(J(body).encode()))
        (wire / "calls.jsonl").write_text("".join(J(r) + "\n" for r in Fake.rows))
        gexit = (logs / "gnomon-exit.txt").read_text().strip() if (logs / "gnomon-exit.txt").exists() else "absent"
        patch = json.loads((logs / "fg1-surface-patch.json").read_text()) if (logs / "fg1-surface-patch.json").exists() else {}
        return p, logs, gexit, patch, wall

    def read_surface(logs):
        out = {n: (logs / f"surface-{n.split('.')[0]}.toml").read_text() for n in SP.FILES
               if (logs / f"surface-{n.split('.')[0]}.toml").exists()}
        prof = {q.name: q.read_text() for q in sorted((logs / "surface-profiles").glob("*.toml"))}
        return out, prof

    def handback(bodies) -> bool:
        for bd in bodies:
            ms = bd.get("messages") or []
            for i in range(1, len(ms)):
                if ms[i].get("role") == "user" and _content(ms[i]).startswith("[gnomon] ") and ms[i - 1].get("role") == "assistant":
                    return True
        return False

    for label in ["C"] + [x for x in want if x != "C"]:
        spec = SP.merge([ctl] + ([] if label == "C" else [frags[label]]))
        p, logs, gexit, patch, wall = run(label, spec)
        say(f"\n{label} ({', '.join(spec['fragments'])}): script rc {p.returncode}, gnomon exit {gexit}, "
            f"{len(Fake.bodies)} requests, {wall:.0f} s; patch {patch.get('actions')}")
        check(p.returncode == 0 and gexit == "0", f"{label}: script and gnomon task exit 0")
        check(patch.get("ok") and patch.get("spec") == spec["sha256"], f"{label}: patch ok with the spec's hash")
        check(not (logs / "fg1-patch-failed.txt").exists(), f"{label}: no patch-failed marker")
        grant = (logs / "fg1-trust-grant.txt").read_text() if (logs / "fg1-trust-grant.txt").exists() else ""
        say("  trust grant: " + " | ".join(l.strip() for l in grant.strip().splitlines()))
        surfaces[label] = read_surface(logs)
        if label != "C":
            base_files, base_prof = surfaces["C"]
            arm_edits = [e for e in spec["edits"] if e not in SP.merge([ctl])["edits"]]
            exp_files, exp_prof, _ = SP.apply_surface(base_files, base_prof, arm_edits)
            got_files, got_prof = surfaces[label]
            check(exp_files == got_files and exp_prof == got_prof,
                  f"{label}: surface = control's + exactly {[(e['file'], e['table'], e['key']) for e in arm_edits]}")
        for r in SP.check_cell(spec["expects"], logs, logs / "wire"):
            if r["severity"] == "fatal":
                check(r["result"] == "pass", f"{label}: expect {r['on']} {r['path']} {r['op']} {r['value']!r} ({r['detail']})")
            else:
                say(f"  info {label}: warn-expectation {r['on']} {r['path']}: {r['result']} ({r['detail']})")
        for r in FC.cell_checks(label, logs, logs / "wire"):
            if r["severity"] == "fatal":
                check(r["result"] == "pass", f"{label}: fg1 check {r['check']}: {r['result']} ({r['detail']})")
            else:
                say(f"  info {label}: fg1 check {r['check']}: {r['result']} ({r['detail']})")
        rec = FC.record(logs) or {}
        aud = FC.audit_records(logs)
        hb = handback(Fake.bodies)
        job_calls = sum(1 for r in Fake.rows for c in r["resp"]["tool_calls"] if c["name"] == "job")
        yields = sum(1 for x in aud if x.get("kind") == "job" and x.get("event") == "yield")
        trust_recs = [x for x in aud if x.get("kind") == "trust" or "trust" in x]
        say(f"  record: stop_reason {rec.get('stop_reason')}, finish_gate {(rec.get('counters') or {}).get('finish_gate')}, "
            f"deadline {(rec.get('volatile') or {}).get('deadline')}")
        say(f"  audit kinds: {sorted({x.get('kind') for x in aud})}; trust-bearing records: "
            f"{[{k: x.get(k) for k in ('kind', 'decision', 'by', 'trust') if k in x} for x in trust_recs][:3]}")
        if label == "FG":
            check(hb, "FG: a user-role '[gnomon] ' hand-back follows the rejected answer on the wire")
            st = FC.gate_stats(rec)
            check(st is not None and st["fired"] and st["applicable"], f"FG: record finish_gate fired and applicable ({st})")
        else:
            check(not hb, f"{label}: no '[gnomon] ' hand-back on the wire")
        if label == "SH":
            check(yields >= 1 and job_calls >= 1, f"SH: {yields} job yield(s) audited, {job_calls} job call(s) on the wire")
        else:
            check(yields == 0 and job_calls == 0, f"{label}: no job yield ({yields}) and no job call ({job_calls})")
        keys = sorted({k for bd in Fake.bodies for k in bd})
        say(f"  request keys: {keys}; tools offered: {Fake.rows[0]['req']['tools'] if Fake.rows else None}")

    # negative control: the control's script without the trust grant
    p, logs, gexit, patch, wall = run("C", SP.merge([ctl]), grant=False)
    auths = [r["auth"] for r in Fake.rows]
    err = (logs / "gnomon-stderr.log").read_text(errors="replace") if (logs / "gnomon-stderr.log").exists() else ""
    clamp = [l.strip() for l in err.splitlines() if "clamp" in l.lower()]
    kc = [r for r in FC.cell_checks("C", logs, logs / "wire") if r["check"] == "key"][0]
    say(f"\nNEGATIVE CONTROL C without the trust grant: gnomon exit {gexit}, {len(auths)} requests, auth {sorted(set(auths))}; "
        f"key check {kc['result']}; clamp notice: {clamp[:1]}")
    check(kc["result"] == "fail" and "placeholder" not in auths,
          "negative control: without the grant the key does not reach the relay and the key check FAILS (detector works)")
    # read-only working directory
    p, logs, gexit, patch, wall = run("C", SP.merge([ctl]), readonly=True)
    root = (logs / "fg1-surface-root.txt").read_text().strip() if (logs / "fg1-surface-root.txt").exists() else "?"
    kc = [r for r in FC.cell_checks("C", logs, logs / "wire") if r["check"] == "key"][0]
    say(f"\nC with a read-only working directory: surface root {root}, gnomon exit {gexit}, key check {kc['result']}")
    check(p.returncode == 0 and gexit == "0" and root not in (".", "?") and patch.get("ok") and kc["result"] == "pass",
          "read-only cwd: state-directory fallback; the patch and the trust grant find it; the key reaches the relay")
    srv.shutdown()
    if a.slots:
        live_slots([int(s) for s in a.slots.split(",") if s.strip()], work)
    say(f"\nwire test: {'PASS' if ok_all else 'FAIL'} (gnomon {b['build_stamp']}, arms ['C'] + {want}, build.toml status "
        f"{b['status']})")
    Path(a.out).write_text("\n".join(LINES) + "\n", encoding="utf-8")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
