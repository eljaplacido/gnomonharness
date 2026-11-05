"""H3 offline wire test, run once before launch with the Harbor venv's python; its output is committed as ../wiretest-h3.txt.

For each arm (R0 GnomonV042, R1 GnomonV042Replay, R2 GnomonV042Hosted) it takes the REAL shell script that the
adapter's run() hands to Harbor (exec_as_agent is captured, nothing is sent anywhere), and runs that script on this
host against the v0.4.2 release build installed from the pinned tarballs (an npm prefix, checked against the same
three pins as the adapter's install), in an empty work dir with an empty HOME/XDG (no keys). /logs/agent is mapped to
a local dir. The model is a fake OpenAI-compatible server on the docker bridge (as the slot relays are) that answers:
call 1 -> reasoning_content + one bash tool call; call 2 -> a final answer.

Checks:
  - the three scripts: R1 = R0 plus exactly one `node -e REPLAY_PATCH || ...` command; R2 = R1 with the patch swapped
  - the surfaces: R1's config.toml = R0's plus exactly the line `replay_reasoning = true` under [endpoints.bench]
  - R1 and R2: the second request's assistant message carries the first reply's reasoning_content; R0's does not
  - R0 vs R1 request bodies are identical once reasoning_content is removed (no other difference on the wire)

  harborvenv/bin/python wiretest_h3.py <npm prefix with gnomon 0.4.2 installed> <empty work dir>
exit 0 when every check holds.
"""
import asyncio
import copy
import difflib
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent.parent / "p2g-2026-11" / "apparatus")]
import gnomon_harbor_v042 as V  # noqa: E402
from gnomon_harbor_h3 import REPLAY_PATCH, GnomonV042Hosted, GnomonV042Replay  # noqa: E402
from gnomon_harbor_h1 import HOSTED_PATCH  # noqa: E402

MODEL = "deepseek-v4.1-flash"
REASONING = "WIRETEST-REASONING: I should list the directory first, then answer."
HOST = "172.17.0.1"
J = json.dumps

prefix, work = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
ok = True


def check(cond: bool, what: str) -> None:
    global ok
    print(f"  {'ok  ' if cond else 'FAIL'} {what}")
    ok = ok and bool(cond)


class Fake(BaseHTTPRequestHandler):
    bodies: list = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        Fake.bodies.append(body)
        n = len(Fake.bodies)
        if n == 1:
            delta = {"role": "assistant", "reasoning_content": REASONING,
                     "tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                     "function": {"name": "bash", "arguments": J({"command": "ls -A"})}}]}
            finish = "tool_calls"
        else:
            delta = {"role": "assistant", "reasoning_content": "WIRETEST-REASONING-2", "content": "Final: listed; nothing to change."}
            finish = "stop"
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
            msg = {k: v for k, v in delta.items() if k != "index"}
            out = J({"choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": usage}).encode()
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
    asyncio.run(a.run("List the files in this directory, then stop.", None, None))
    return got["command"], got["env"]


# The local build must carry the same three pins the adapter's install checks.
gn_bin = prefix / "bin"
stamp = json.loads((prefix / "lib/node_modules/gnomon-core/package.json").read_text())["gnomonBuild"]
home = work / "home"
xenv = {"PATH": f"{gn_bin}:{os.environ['PATH']}", "HOME": str(home), "XDG_DATA_HOME": str(home / "xdg"),
        "XDG_CONFIG_HOME": str(home / "xdgc"), "NO_COLOR": "1", "LANG": "C.UTF-8"}
home.mkdir(parents=True)
(home / ".nvm").mkdir()
(home / ".nvm" / "nvm.sh").write_text("# wiretest stub: node and gnomon are on PATH\n")
(home / ".gnomon-release").write_text(f"gnomon v{V.V042} {V.V042_COMMIT[:16]} wiretest-local-prefix\n")
ver = subprocess.run(["gnomon", "--version"], env=xenv, capture_output=True, text=True).stdout.strip().splitlines()[-1]
print(f"== H3 wire test: build {stamp}, `gnomon --version` = {ver}")
check(stamp == V.V042_BUILD and ver == f"gnomon/{V.V042}+{V.V042_BUILD}", "local build carries the adapter's gnomonBuild and --version pins")

srv = ThreadingHTTPServer((HOST, 0), Fake)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base_url = f"http://{HOST}:{srv.server_address[1]}/openai/v1"
arms = {"R0": V.GnomonV042, "R1": GnomonV042Replay, "R2": GnomonV042Hosted}
res = {}
cwd = work / "cwd"  # the same path for every arm, emptied between arms
for arm, cls in arms.items():
    script, env = script_of(cls, base_url)
    logs = work / f"logs-{arm}"
    logs.mkdir()
    shutil.rmtree(cwd, ignore_errors=True)
    cwd.mkdir()
    Fake.bodies = []
    run_env = {**xenv, **env}
    p = subprocess.run(["bash", "-c", script.replace("/logs/agent", str(logs))], cwd=cwd, env=run_env,
                       capture_output=True, text=True, timeout=300)
    bodies = copy.deepcopy(Fake.bodies)
    (logs / "requests.json").write_text(J(bodies, indent=1))
    surface = (logs / "surface-config.toml").read_text() if (logs / "surface-config.toml").exists() else ""
    gexit = (logs / "gnomon-exit.txt").read_text().strip() if (logs / "gnomon-exit.txt").exists() else "absent"
    res[arm] = {"script": script, "bodies": bodies, "surface": surface}
    second = bodies[1] if len(bodies) > 1 else {"messages": []}
    asst = [m for m in second["messages"] if m.get("role") == "assistant"]
    rc = [m.get("reasoning_content") for m in asst]
    print(f"\n{arm} ({cls.__name__}): script rc {p.returncode}, gnomon exit {gexit}, {len(bodies)} requests reached the fake server; "
          f"stream={bodies[0].get('stream') if bodies else None}; 2nd request assistant reasoning_content={rc}")
    check(p.returncode == 0 and gexit == "0", f"{arm}: the adapter script and gnomon task exit 0")
    check(len(bodies) == 2, f"{arm}: exactly two model requests (tool call, then final)")
    check(not any("reasoning_content" in m for m in bodies[0]["messages"]) if bodies else False, f"{arm}: first request has no reasoning_content")
    if arm == "R0":
        check(len(asst) == 1 and "reasoning_content" not in asst[0], "R0: second request's assistant message has NO reasoning_content")
    else:
        check(len(asst) == 1 and asst[0].get("reasoning_content") == REASONING, f"{arm}: second request's assistant message carries the reasoning_content")
    check("h3-replay-patch-failed" not in " ".join(os.listdir(logs)) and "h1-patch-failed" not in " ".join(os.listdir(logs)), f"{arm}: no patch-failed marker")

print("\n== R0 vs R1")
s0, s1, s2 = res["R0"]["script"], res["R1"]["script"], res["R2"]["script"]
import shlex  # noqa: E402
replay_cmd = f"node -e {shlex.quote(REPLAY_PATCH)} || {{ echo 'H3 replay patch failed' > /logs/agent/h3-replay-patch-failed.txt; exit 3; }}; "
hosted_cmd = f"node -e {shlex.quote(HOSTED_PATCH)} || {{ echo 'H1 hosted patch failed' > /logs/agent/h1-patch-failed.txt; exit 3; }}; "
anchor = "cp .gnomon/config.toml /logs/agent/surface-config.toml; "
check(s1 == s0.replace(anchor, replay_cmd + anchor, 1), "script: R1 = R0 + exactly the REPLAY_PATCH command")
check(s2 == s1.replace(replay_cmd, hosted_cmd, 1), "script: R2 = R1 with REPLAY_PATCH swapped for H1's HOSTED_PATCH")
sd = [l for l in difflib.unified_diff(res["R0"]["surface"].splitlines(), res["R1"]["surface"].splitlines(), lineterm="", n=0)
      if l[:1] in "+-" and not l.startswith(("+++", "---"))]
print(f"  surface diff R0 -> R1: {sd}")
check(sd == ["+replay_reasoning = true"], "surface: R1 = R0 + exactly `replay_reasoning = true`")
check("[endpoints.bench]\nreplay_reasoning = true\n" in res["R1"]["surface"], "surface: the line is inside [endpoints.bench]")
sd2 = [l for l in difflib.unified_diff(res["R0"]["surface"].splitlines(), res["R2"]["surface"].splitlines(), lineterm="", n=0)
       if l[:1] in "+-" and not l.startswith(("+++", "---"))]
print(f"  surface diff R0 -> R2: {sd2}")


def strip_rc(b):
    b = copy.deepcopy(b)
    for m in b.get("messages", []):
        m.pop("reasoning_content", None)
    return b


b0, b1 = res["R0"]["bodies"], res["R1"]["bodies"]
same = len(b0) == len(b1) and all(strip_rc(x) == strip_rc(y) for x, y in zip(b0, b1))
if not same:
    for i, (x, y) in enumerate(zip(b0, b1)):
        for l in difflib.unified_diff(J(strip_rc(x), indent=1, sort_keys=True).splitlines(),
                                      J(strip_rc(y), indent=1, sort_keys=True).splitlines(), lineterm="", n=1):
            print(f"  req{i + 1} {l[:200]}")
check(same, "wire: R0 and R1 request bodies are byte-identical apart from reasoning_content")
keys0 = sorted(set(k for b in b0 for k in b)); keys2 = sorted(set(k for b in res["R2"]["bodies"] for k in b))
print(f"  request keys R0 {keys0}; R2 {keys2}")
srv.shutdown()
print(f"\nwire test: {'PASS' if ok else 'FAIL'} (gnomon {V.V042_BUILD})")
sys.exit(0 if ok else 1)
