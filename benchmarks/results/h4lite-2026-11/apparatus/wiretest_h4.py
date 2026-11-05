"""H4-lite offline wire test, run once before launch with the Harbor venv's python; its output is committed as
../wiretest-h4lite.txt.

For each arm (C GnomonM152Hosted, G GnomonM152Gate) it takes the REAL shell script that the adapter's run() hands to
Harbor (exec_as_agent is captured, nothing is sent anywhere), and runs that script on this host against the master
ae17a1ae build installed from the pinned tarballs (an npm prefix, checked against the adapter's stamp and --version
pins), in an empty work dir (not a git repository) with an empty HOME/XDG (no keys). /logs/agent is mapped to a
local dir. The model is a fake OpenAI-compatible server on the docker bridge (as the slot relays are), a fixed
policy over the conversation (G1gate's wiretest_g1g.mjs policy, ported), so both arms meet the same model:
  main turn (gate notes read from user or system messages): write out.txt by bash, then answer; after a checklist hand-back answer again at once (no check);
  after a no_check hand-back run `cat out.txt`, then answer; after a reviewer's findings rewrite and `cat`, answer.
  reviewer sub-turn (recognised by its instruction): `ls -la`, then report one finding.
Every reply carries reasoning_content (the recipe replays it).

Checks: the scripts (G = C + exactly the GATE_PATCH command); the surfaces (config/roles identical, policy differs
by the [verify] completion_gate block only); C: two requests, no gate; G: C's two request bodies byte-identical,
then a checklist hand-back as a [gnomon] note on the first done, a reviewer sub-turn, gate counters; GATE_PATCH on
init's own [verify] block (pyproject scaffold) and its refusals (exit 3).

  harborvenv/bin/python wiretest_h4.py <npm prefix with the master build installed> <empty work dir>
exit 0 when every check holds.
"""
import asyncio
import copy
import difflib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent.parent / "p2g-2026-11" / "apparatus")]
import gnomon_harbor_m152 as V  # noqa: E402
from gnomon_harbor_h4 import GATE_PATCH, GnomonM152Gate, GnomonM152Hosted  # noqa: E402
from gnomon_harbor_h1 import HOSTED_PATCH  # noqa: E402

MODEL = "deepseek-v4.1-flash"
HOST = "172.17.0.1"
J = json.dumps
TASK = ("Write the word hello into a file named `out.txt` in this directory.\n\nRequirements:\n"
        "- The file must contain exactly one line.\n- Do not create any other file.")
REVIEWER_MARK = "You are reviewing finished work"
GATE_RE = re.compile(r"Completion gate \(round (\d+) of (\d+)\): (your answer is not accepted yet|no command has run since the checklist|an independent read-only reviewer)")
KIND = {"your answer is not accepted yet": "checklist", "no command has run since the checklist": "no_check",
        "an independent read-only reviewer": "findings"}

prefix, work = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
ok = True


def check(cond, what: str) -> None:
    global ok
    print(f"  {'ok  ' if cond else 'FAIL'} {what}")
    ok = ok and bool(cond)


def text_of(c) -> str:
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join((p or {}).get("text", "") for p in c if isinstance(p, dict))
    return ""


def call(n, name, args):
    return {"tool_calls": [{"index": 0, "id": f"call_{n}", "type": "function", "function": {"name": name, "arguments": J(args)}}]}


def policy(body: dict, n: int) -> dict:
    msgs = body.get("messages") or []
    tools = isinstance(body.get("tools"), list) and len(body["tools"]) > 0
    say = lambda s: {"content": s}  # noqa: E731
    if not tools:
        return say("Done: out.txt holds the line.")
    if any(m.get("role") == "user" and REVIEWER_MARK in text_of(m.get("content")) for m in msgs):
        calls = sum(1 for m in msgs if m.get("role") == "assistant" and m.get("tool_calls"))
        if calls == 0:
            return call(n, "bash", {"command": "ls -la"})
        return say("- out.txt holds `hi`, but the task asks for the word hello (cat out.txt printed: hi)")
    last, at = None, -1
    for i, m in enumerate(msgs):
        if m.get("role") not in ("user", "system"):  # the recipe keeps steer_role's default: notes go as system messages
            continue
        for g in GATE_RE.finditer(text_of(m.get("content"))):
            last, at = KIND[g.group(3)], i
    since = sum(1 for m in msgs[at + 1:] if m.get("role") == "assistant" and m.get("tool_calls"))
    if last is None:
        return call(n, "bash", {"command": "printf 'hi\\n' > out.txt"}) if since == 0 else say("Done: wrote out.txt.")
    if last == "checklist":
        return say("Checked: out.txt holds one line.")
    if last == "no_check":
        return call(n, "bash", {"command": "cat out.txt"}) if since == 0 else say("Checked with cat: out.txt holds one line.")
    if since == 0:
        return call(n, "bash", {"command": "printf 'hello\\n' > out.txt"})
    if since == 1:
        return call(n, "bash", {"command": "cat out.txt"})
    return say("Fixed: out.txt now holds hello, checked with cat.")


class Fake(BaseHTTPRequestHandler):
    bodies: list = []
    lock = threading.Lock()

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        with Fake.lock:
            Fake.bodies.append(body)
            n = len(Fake.bodies)
        delta = {"role": "assistant", "reasoning_content": f"WIRETEST-REASONING-{n}", **policy(body, n)}
        finish = "tool_calls" if "tool_calls" in delta else "stop"
        usage = {"prompt_tokens": 100 + n, "completion_tokens": 10, "total_tokens": 110 + n}
        if body.get("stream"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            for chunk in ({"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                          {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
                          {"choices": [], "usage": usage}):
                self.wfile.write(f"data: {J(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            out = J({"choices": [{"index": 0, "message": delta, "finish_reason": finish}], "usage": usage}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)


def script_of(cls, base_url: str) -> tuple[str, dict]:
    got = {}

    async def capture(self, environment, command, env=None, **kw):
        got["command"], got["env"] = command, dict(env or {})

    T = type("T", (cls,), {"model_connection": SimpleNamespace(env={"OPENAI_BASE_URL": base_url, "OPENAI_API_KEY": "wiretest-placeholder"}),
                           "render_instruction": lambda self, s: s, "exec_as_agent": capture})
    a = T.__new__(T)
    a.model_name = f"openai/{MODEL}"
    asyncio.run(a.run(TASK, None, None))
    return got["command"], got["env"]


def find_key(o, key):
    if isinstance(o, dict):
        if key in o and isinstance(o[key], dict):
            return o[key]
        for v in o.values():
            r = find_key(v, key)
            if r is not None:
                return r
    elif isinstance(o, list):
        for v in o:
            r = find_key(v, key)
            if r is not None:
                return r
    return None


def gate_records(audit: Path) -> list[dict]:
    out = []
    if audit.exists():
        for f in sorted(audit.rglob("*")):
            if f.is_file():
                for line in f.read_text(errors="replace").splitlines():
                    if '"completion_gate"' in line:
                        try:
                            r = json.loads(line)
                        except Exception:
                            continue
                        if r.get("kind") == "completion_gate":
                            out.append(r)
    return out


def is_rev(b):
    return any(m.get("role") == "user" and REVIEWER_MARK in text_of(m.get("content")) for m in b.get("messages", []))


# The local build must carry the same pins the adapter's install checks.
gn_bin = prefix / "bin"
stamp = json.loads((prefix / "lib/node_modules/gnomon-core/package.json").read_text())["gnomonBuild"]
home = work / "home"
xenv = {"PATH": f"{gn_bin}:{os.environ['PATH']}", "HOME": str(home), "XDG_DATA_HOME": str(home / "xdg"),
        "XDG_CONFIG_HOME": str(home / "xdgc"), "NO_COLOR": "1", "LANG": "C.UTF-8"}
home.mkdir(parents=True)
(home / ".nvm").mkdir()
(home / ".nvm" / "nvm.sh").write_text("# wiretest stub: node and gnomon are on PATH\n")
(home / ".gnomon-release").write_text(f"gnomon v{V.M152} {V.M152_COMMIT[:16]} wiretest-local-prefix\n")
ver = subprocess.run(["gnomon", "--version"], env=xenv, capture_output=True, text=True).stdout.strip().splitlines()[-1]
print(f"== H4-lite wire test: build {stamp}, `gnomon --version` = {ver}")
check(stamp == V.M152_BUILD and ver == f"gnomon/{V.M152}+{V.M152_BUILD}", "local build carries the adapter's gnomonBuild and --version pins")

srv = ThreadingHTTPServer((HOST, 0), Fake)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base_url = f"http://{HOST}:{srv.server_address[1]}/openai/v1"
arms = {"C": GnomonM152Hosted, "G": GnomonM152Gate}
res = {}
cwd = work / "cwd"  # the same path for every arm, emptied between arms
for arm, cls in arms.items():
    script, env = script_of(cls, base_url)
    logs = work / f"logs-{arm}"
    logs.mkdir()
    shutil.rmtree(cwd, ignore_errors=True)
    cwd.mkdir()
    Fake.bodies = []
    p = subprocess.run(["bash", "-c", script.replace("/logs/agent", str(logs))], cwd=cwd, env={**xenv, **env},
                       capture_output=True, text=True, timeout=600)
    bodies = copy.deepcopy(Fake.bodies)
    (logs / "requests.json").write_text(J(bodies, indent=1))
    rd = lambda f: (logs / f).read_text() if (logs / f).exists() else ""  # noqa: E731
    gexit = rd("gnomon-exit.txt").strip() or "absent"
    try:
        task_json = json.loads(rd("gnomon-task.json") or "null")
    except Exception:
        task_json = None
    cg = find_key(task_json, "completion_gate")
    recs = gate_records(logs / "audit")
    notes = [text_of(m.get("content")) for b in bodies if not is_rev(b) for m in b.get("messages", [])
             if m.get("role") in ("user", "system") and GATE_RE.search(text_of(m.get("content")))]
    res[arm] = {"script": script, "bodies": bodies, "config": rd("surface-config.toml"), "roles": rd("surface-roles.toml"),
                "policy": rd("surface-policy.toml"), "cg": cg, "recs": recs, "out": (cwd / "out.txt").read_text() if (cwd / "out.txt").exists() else None}
    rev = [b for b in bodies if is_rev(b)]
    print(f"\n{arm} ({cls.__name__}): script rc {p.returncode}, gnomon exit {gexit}, {len(bodies)} requests reached the fake server "
          f"({len(rev)} from a reviewer); out.txt = {res[arm]['out']!r}")
    print(f"  counters.completion_gate: {J(cg)}")
    print(f"  completion_gate records: {J([{k: v for k, v in r.items() if k not in ('ts', 'prev', 'hash', 'sig')} for r in recs])[:1200]}")
    check(p.returncode == 0 and gexit == "0", f"{arm}: the adapter script and gnomon task exit 0")
    check(not any(f.name.endswith("patch-failed.txt") for f in logs.iterdir()), f"{arm}: no patch-failed marker")
    if len(bodies) > 1:
        asst = [m for m in bodies[1]["messages"] if m.get("role") == "assistant"]
        check(len(asst) == 1 and asst[0].get("reasoning_content") == "WIRETEST-REASONING-1", f"{arm}: the recipe replays reasoning_content (2nd request)")
    if arm == "C":
        check(len(bodies) == 2, "C: exactly two model requests (write, then done): the first done is accepted")
        check(not notes and not rev, "C: no gate note on the wire and no reviewer")
        check(cg is None or cg.get("mode") in (None, "off"), "C: no completion_gate counters (or mode off)")
        check(not recs, "C: no completion_gate audit record")
    else:
        check(len(notes) >= 1 and "Completion gate (round 1 of 3): your answer is not accepted yet" in notes[0],
              "G: the first done was handed back with a checklist (a gate note, round 1 of 3)")
        print(f"  gate notes: {len(notes)}, roles {[m.get('role') for b in bodies[2:3] for m in b.get('messages', [])[len(bodies[1]['messages']) + 1:]]}")
        check(len(rev) >= 1, "G: a reviewer sub-turn ran (review mode)")
        if rev:
            tools = sorted({(t.get("function") or {}).get("name") for b in rev for t in (b.get("tools") or [])})
            first = rev[0]["messages"]
            print(f"  reviewer: {len(rev)} requests; tools offered {tools}; first request roles {[m.get('role') for m in first]}")
            check("write" not in tools and "edit" not in tools, "G: the reviewer was not offered write/edit")
        check(bool(cg) and cg.get("mode") == "review" and (cg.get("reviews") or 0) >= 1, "G: counters.completion_gate says mode review, reviews >= 1")
        check(any(r.get("action") == "checklist" for r in recs) and any(r.get("action") == "review" for r in recs),
              "G: the audit trail records the checklist and the review")
        check(res[arm]["out"] == "hello\n", "G: the reviewer's finding reached the main turn and was acted on (out.txt = hello)")

print("\n== C vs G")
sC, sG = res["C"]["script"], res["G"]["script"]
hosted_cmd = f"node -e {shlex.quote(HOSTED_PATCH)} || {{ echo 'H1 hosted patch failed' > /logs/agent/h1-patch-failed.txt; exit 3; }}; "
gate_cmd = f"node -e {shlex.quote(GATE_PATCH)} || {{ echo 'H4 gate patch failed' > /logs/agent/h4-gate-patch-failed.txt; exit 3; }}; "
check(sC.count(hosted_cmd) == 1 and sG == sC.replace(hosted_cmd, hosted_cmd + gate_cmd, 1), "script: G = C + exactly the GATE_PATCH command, after HOSTED_PATCH")
check(res["C"]["config"] == res["G"]["config"] and res["C"]["config"] != "", "surface: config.toml identical (the recipe in both)")
check("[endpoints.bench]\nreplay_reasoning = true\nmax_context_tokens = 1000000\n" in res["C"]["config"]
      and re.search(r"^nudge_after_idle = 100000\b", res["C"]["config"], re.M), "surface: the hosted recipe's three lines are in config.toml")
check(res["C"]["roles"] == res["G"]["roles"], "surface: roles.toml identical")
pd = [l for l in difflib.unified_diff(res["C"]["policy"].splitlines(), res["G"]["policy"].splitlines(), lineterm="", n=0)
      if l[:1] in "+-" and not l.startswith(("+++", "---"))]
print(f"  policy.toml diff C -> G: {pd}")
check(res["G"]["policy"] == res["C"]["policy"].rstrip() + '\n\n[verify]\ncompletion_gate = "review"\n', "surface: G's policy.toml = C's + [verify] completion_gate = \"review\" (no [verify] from init here)")
bC, bG = res["C"]["bodies"], res["G"]["bodies"]
same = len(bC) == 2 and len(bG) > 2 and J(bC[0], sort_keys=True) == J(bG[0], sort_keys=True) and J(bC[1], sort_keys=True) == J(bG[1], sort_keys=True)
if not same:
    for i, (x, y) in enumerate(zip(bC, bG)):
        for l in difflib.unified_diff(J(x, indent=1, sort_keys=True).splitlines(), J(y, indent=1, sort_keys=True).splitlines(), lineterm="", n=1):
            print(f"  req{i + 1} {l[:200]}")
check(same, "wire: C's two request bodies and G's first two are byte-identical (the gate acts only at the first done)")
g3 = bG[2] if len(bG) > 2 else {}
g3_extra = [text_of(m.get("content"))[:90] for m in g3.get("messages", [])[len(bG[1]["messages"]) + 1:]] if g3 else []
print(f"  G request 3 = request 2 + the done answer + {g3_extra}")
check(bool(g3) and {k: v for k, v in g3.items() if k != "messages"} == {k: v for k, v in bG[1].items() if k != "messages"},
      "wire: G's later requests keep C's request parameters (model, tools, sampling); only messages grow")
print(f"  request keys C {sorted(set(k for b in bC for k in b))}; G {sorted(set(k for b in bG for k in b))}")
srv.shutdown()

# GATE_PATCH on init's own [verify] block (a pyproject scaffold) and its refusals.
print("\n== GATE_PATCH on other policy.toml shapes")


def gate_on(policy_text: str | None, scaffold: dict | None = None) -> tuple[int, str]:
    d = work / f"gp-{abs(hash((policy_text, J(scaffold)))) % 10**8}"
    d.mkdir()
    for k, v in (scaffold or {}).items():
        (d / k).write_text(v)
    if policy_text is None:
        subprocess.run(["gnomon", "init"], cwd=d, env=xenv, capture_output=True, text=True, timeout=120)
    else:
        (d / ".gnomon").mkdir()
        (d / ".gnomon" / "policy.toml").write_text(policy_text)
    p = subprocess.run(["node", "-e", GATE_PATCH], cwd=d, env=xenv, capture_output=True, text=True)
    return p.returncode, (d / ".gnomon" / "policy.toml").read_text()


rc, pol = gate_on(None, {"pyproject.toml": '[project]\nname = "x"\n'})
mv = re.search(r"^\[verify\]", pol, re.M)
blk = pol[mv.start():] if mv else ""
print(f"  pyproject scaffold: rc {rc}; [verify] block: {blk.splitlines()[:3]}")
check(rc == 0 and blk.startswith('[verify]\ncompletion_gate = "review"\ncommand = "pytest -q"') and len(re.findall(r"^\[verify\]", pol, re.M)) == 1,
      "GATE_PATCH joins init's own [verify] block (pytest check kept), directly under its header")
for name, bad in (("a completion_* key already present", '[verify]\ncompletion_rounds = 2\n'),
                  ("two [verify] headers", '[verify]\ncommand = "x"\n[verify]\ncommand = "y"\n'),
                  ("a [verify] header with a comment", '[verify] # c\ncommand = "x"\n')):
    rc, _ = gate_on(bad)
    check(rc == 3, f"GATE_PATCH refuses (exit 3): {name}")
print(f"\nwire test: {'PASS' if ok else 'FAIL'} (gnomon {V.M152_BUILD})")
sys.exit(0 if ok else 1)
