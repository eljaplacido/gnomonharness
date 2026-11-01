"""G1c SECONDARY view: what cacogate's kernel would have decided on every tool call the
agent attempted, replayed offline. The cacogate arm could not run live (its OpenCode
adapter is never called by opencode V2 2.2.5; runs/_controls/nc-caco.txt), so this
measures the kernel's policy, not a shipped integration. It never feeds ground truth.

Per trial: a fresh g1c-agent container with no network, the trial's template repo at
/workspace/inventory (base state), and `cacogate check --tool <tool> ... --json` (no
daemon, no session history; built-in policy `builtin:strict`) on each attempted call
from opencode's own event stream, in order. Writes cacogate-replay.json per trial.

    python3 -I cacogate_replay.py <runs dir>
"""
import json
import subprocess
import sys
from pathlib import Path

RUNS = Path(sys.argv[1])
IMAGE = "g1c-agent:2026-11"
FILE_TOOLS = {"write", "edit", "read", "patch", "apply_patch"}


def calls(stdout: Path):
    out = []
    for line in stdout.read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        p = e.get("part") or {}
        if e.get("type") != "tool_use" or p.get("type") != "tool":
            continue
        st = p.get("state") or {}
        inp = st.get("input") or {}
        out.append({"tool": p.get("tool"), "input": inp, "status": st.get("status"),
                    "gate_refused": "gnomon guard" in json.dumps(st.get("error") or "")})
    return out


def sh(cmd, **kw):
    return subprocess.run(cmd, text=True, capture_output=True, **kw)


for d in sorted(RUNS.iterdir()):
    tj = d / "trial.json"
    if not tj.exists() or (d / "cacogate-replay.json").exists():
        continue
    t = json.loads(tj.read_text())
    cs = calls(d / "stdout.txt")
    name = f"g1c-cr-{t['seq']:03d}"
    sh(["docker", "rm", "-f", name])
    sh(["docker", "run", "-d", "--name", name, "--network", "none", "-u", "root", IMAGE, "sleep", "600"])
    try:
        sh(["docker", "exec", name, "mkdir", "-p", "/workspace/inventory"])
        sh(["docker", "cp", str(RUNS / "_templates" / f"{t['task']}.tar"), f"{name}:/tmp/t.tar"])
        sh(["docker", "exec", name, "bash", "-c",
            "tar -xf /tmp/t.tar -C /workspace/inventory && chown -R node:node /workspace"])
        res = []
        for c in cs:
            tool, inp = c["tool"], c["input"]
            if tool == "shell" and isinstance(inp.get("command"), str):
                args = ["--tool", "shell", "-c", inp["command"]]
            elif tool in FILE_TOOLS and isinstance(inp.get("path") or inp.get("filePath"), str):
                args = ["--tool", tool, "--file", inp.get("path") or inp.get("filePath")]
            else:
                res.append({**c, "cacogate": None, "note": "no cacogate mapping for this call"})
                continue
            r = sh(["docker", "exec", "-u", "node", "-w", "/workspace/inventory", name, "cacogate", "check",
                    *args, "--cwd", "/workspace/inventory", "--json"])
            try:
                dec = json.loads(r.stdout)["decision"]
                verdict = dec["verdict"]
                rule = [c["id"] for c in dec.get("checks", []) if c.get("status") == "failed"]
            except Exception:
                verdict, rule = "unparsed", r.stdout[-200:] + r.stderr[-200:]
            res.append({**c, "cacogate": verdict, "rule": rule})
    finally:
        sh(["docker", "rm", "-f", name])
    (d / "cacogate-replay.json").write_text(json.dumps(res, indent=1))
    held = [r for r in res if r.get("cacogate") not in (None, "allow")]
    print(f"{d.name:44s} calls={len(res):3d} would-hold={len(held):2d} "
          f"{sorted({x for r in held for x in (r.get('rule') or [])})[:5]}")
