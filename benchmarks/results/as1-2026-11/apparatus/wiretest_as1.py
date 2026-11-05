"""AS1 pre-launch wire test: every arm's REAL cell script against the PINNED build and a fake model. Run once the build
is pinned (build.toml filled), before any cell; its output is committed as ../wiretest-as1.txt and its sha256 goes into
build.toml (`wiretest`), which run_as1.py check requires.

    python3 wiretest_as1.py <npm prefix with the pinned build installed> <empty work dir> [--arms CTL.A,GC,...]

No Harbor, no Docker, no model, no key: the script is surface_patch.run_script (exactly what GnomonAS1.run hands to
Harbor), run with bash on this host in an empty HOME/XDG, /logs/agent mapped to a local dir. The model is a fake
OpenAI-compatible server on the docker bridge (as the slot relays are) that answers odd requests with reasoning_content
+ one bash call that writes a file (so the worktree changes and the completion gate applies) and even requests with a
final answer; after 12 requests it only answers.

Checks, per arm (and the control, and the A/A arm):
  - the local build carries build.toml's gnomonBuild and `gnomon --version` pins;
  - the script exits 0, gnomon exits 0, the patch reports ok with the spec's hash, no as1-patch-failed.txt;
  - surface: the arm's config/roles/policy/profiles = the control's run + exactly the arm's edits (Python reference);
  - every FATAL expectation of the spec passes on this run (an 'unverifiable' one fails here: the fake run must
    produce what the real cells will be checked against);
  - the control, again with a read-only working directory: gnomon falls back to the state directory, the patch finds
    it (as1-surface-root.txt), and the run exits 0 (PR #153 4a; risk-scorer-replay in the confirmatory stage).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent.parent / "p2g-2026-11" / "apparatus")]
import surface_patch as SP  # noqa: E402

MODEL = "deepseek-v4.1-flash"
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


class Fake(BaseHTTPRequestHandler):
    n = 0
    bodies: list = []

    def log_message(self, *a):
        pass

    def do_GET(self):  # a /models listing behind the relay answers 404, as Go's does
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        Fake.bodies.append(json.loads(self.rfile.read(int(self.headers.get("content-length", 0)))))
        Fake.n += 1
        n = Fake.n
        if n % 2 == 1 and n < 12:
            delta = {"role": "assistant", "reasoning_content": f"WIRETEST-REASONING-{n}",
                     "tool_calls": [{"index": 0, "id": f"call_{n}", "type": "function", "function": {
                         "name": "bash", "arguments": J({"command": f"echo wiretest-{n} >> wiretest.txt; ls -A"})}}]}
            finish = "tool_calls"
        else:
            delta = {"role": "assistant", "reasoning_content": f"WIRETEST-REASONING-{n}", "content": "Done. NO FINDINGS"}
            finish = "stop"
        usage = {"prompt_tokens": 100 + n, "completion_tokens": 10, "total_tokens": 110 + n}
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for chunk in ({"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                      {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}, {"choices": [], "usage": usage}):
            self.wfile.write(f"data: {J(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("prefix")
    ap.add_argument("work")
    ap.add_argument("--arms", default="")
    ap.add_argument("--out", default=str(HERE.parent / "wiretest-as1.txt"))
    a = ap.parse_args()
    import tomllib
    from gnomon_harbor import _PATCH
    b = tomllib.loads((HERE / "build.toml").read_text())["build"]
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
    say(f"== AS1 wire test: build {stamp}, `gnomon --version` = {ver}; build.toml {b['version']} {b['commit'][:12]}")
    check(stamp == b["build_stamp"] and ver == f"gnomon/{b['version']}+{b['build_stamp']}", "local build = build.toml pins")
    host = "172.17.0.1"
    try:
        srv = ThreadingHTTPServer((host, 0), Fake)
    except OSError:
        host = "127.0.0.1"
        srv = ThreadingHTTPServer((host, 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://{host}:{srv.server_address[1]}/openai/v1"
    run_env = {**xenv, "OPENAI_BASE_URL": base, "OPENAI_API_KEY": "wiretest-placeholder",
               "GNOMON_BENCH_URL": f"{base}/chat/completions", "GNOMON_BENCH_MODEL": MODEL}
    frags = SP.load_all()
    ctl = frags[f"CTL.{b['branch']}"]
    want = [x for x in a.arms.split(",") if x] or sorted(
        f.id for f in frags.values() if f.family not in ("control",) and b["branch"] in f.branches
        and f.status in ("ready", "optional") and set(f.requires) <= set(b["knobs"]))
    cwd = work / "cwd"
    surfaces = {}

    def run(label, spec, readonly=False):
        logs = work / f"logs-{label}{'-ro' if readonly else ''}"
        logs.mkdir()
        shutil.rmtree(cwd, ignore_errors=True)
        cwd.mkdir()
        shutil.rmtree(home / "state", ignore_errors=True)
        if readonly:
            cwd.chmod(0o555)
        Fake.n = 0
        Fake.bodies = []
        script = SP.run_script(spec, "Append a line to wiretest.txt, then stop.", _PATCH).replace("/logs/agent", str(logs))
        p = subprocess.run(["bash", "-c", script], cwd=cwd, env=run_env, capture_output=True, text=True, timeout=600)
        if readonly:
            cwd.chmod(0o755)
        wire = logs / "wire"
        wire.mkdir()
        import gzip
        for i, body in enumerate(Fake.bodies, 1):
            (wire / f"req-{i:04d}.json.gz").write_bytes(gzip.compress(J(body).encode()))
        gexit = (logs / "gnomon-exit.txt").read_text().strip() if (logs / "gnomon-exit.txt").exists() else "absent"
        patch = json.loads((logs / "as1-surface-patch.json").read_text()) if (logs / "as1-surface-patch.json").exists() else {}
        return p, logs, gexit, patch

    def read_surface(logs):
        out = {n: (logs / f"surface-{n.split('.')[0]}.toml").read_text() for n in SP.FILES
               if (logs / f"surface-{n.split('.')[0]}.toml").exists()}
        prof = {q.name: q.read_text() for q in sorted((logs / "surface-profiles").glob("*.toml"))}
        return out, prof

    for label in [ctl.id] + [x for x in want if x != ctl.id]:
        spec = SP.merge([ctl] + ([] if label == ctl.id else [frags[label]]))
        p, logs, gexit, patch = run(label, spec)
        say(f"\n{label} ({', '.join(spec['fragments'])}): script rc {p.returncode}, gnomon exit {gexit}, "
            f"{len(Fake.bodies)} requests; patch {patch.get('actions')}")
        check(p.returncode == 0 and gexit == "0", f"{label}: script and gnomon task exit 0")
        check(patch.get("ok") and patch.get("spec") == spec["sha256"], f"{label}: patch ok with the spec's hash")
        check(not (logs / "as1-patch-failed.txt").exists(), f"{label}: no patch-failed marker")
        surfaces[label] = read_surface(logs)
        if label != ctl.id:
            base_files, base_prof = surfaces[ctl.id]
            arm_edits = [e for e in spec["edits"] if e not in SP.merge([ctl])["edits"]]
            exp_files, exp_prof, _ = SP.apply_surface(base_files, base_prof, arm_edits)
            got_files, got_prof = surfaces[label]
            check(exp_files == got_files and exp_prof == got_prof,
                  f"{label}: surface = control's + exactly {[(e['file'], e['table'], e['key']) for e in arm_edits]}")
        for r in SP.check_cell(spec["expects"], logs, logs / "wire"):  # logs = this run's /logs/agent
            if r["severity"] == "fatal":
                check(r["result"] == "pass", f"{label}: expect {r['on']} {r['path']} {r['op']} {r['value']!r} ({r['detail']})")
            else:
                say(f"  info {label}: warn-expectation {r['on']} {r['path']}: {r['result']} ({r['detail']})")
        keys = sorted({k for bd in Fake.bodies for k in bd})
        say(f"  request keys: {keys}")
    p, logs, gexit, patch = run(ctl.id, SP.merge([ctl]), readonly=True)
    root = (logs / "as1-surface-root.txt").read_text().strip() if (logs / "as1-surface-root.txt").exists() else "?"
    say(f"\n{ctl.id} with a read-only working directory: surface root {root}, gnomon exit {gexit}")
    check(p.returncode == 0 and gexit == "0" and root not in (".", "?") and patch.get("ok"),
          "read-only cwd: gnomon falls back to the state directory and the patch finds it")
    srv.shutdown()
    say(f"\nwire test: {'PASS' if ok_all else 'FAIL'} (gnomon {b['build_stamp']}, branch {b['branch']}, arms {want})")
    Path(a.out).write_text("\n".join(LINES) + "\n", encoding="utf-8")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
