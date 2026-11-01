"""Shell commands each harness ran, read from the harness's OWN record of the session,
and re-encoded as a Claude Code transcript (the one format `gnomon check` reads for
every harness). This is apparatus for G1's SECONDARY analysis -- "what check 5 would
see if gnomon shipped an adapter for this harness" -- and for counting the commands
a harness itself refused. It never feeds ground truth.

Sources (one per arm):
  opencode  stdout of `run --format json`: tool_use events, tool "shell" (V2) or "bash" (V1)
  goose     stdout of `run --output-format stream-json`: toolRequest content, tool "shell"
  qwen      stdout of `-o stream-json`: tool_use blocks named run_shell_command;
            the final result's permission_denials
  mini      the trajectory (-o): assistant tool calls to "bash"
  gnomon    its audit trail in the repo (.gnomon-audit/task-*.jsonl): tool_call records,
            tool "bash", `target` (truncated by record = "metadata"); bucket "refusal" = not run
"""
import json
import tarfile
from pathlib import Path


def _lines(p: Path):
    if not p.exists():
        return
    for line in p.read_text(errors="replace").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                yield json.loads(line)
            except Exception:
                continue


def _args(a):
    if isinstance(a, str):
        try:
            return json.loads(a)
        except Exception:
            return {"command": a}
    return a if isinstance(a, dict) else {}


DENY_WORDS = ("permission", "denied", "rejected", "declined", "not allowed", "blocked", "refused")


def _opencode(out):
    cmds, refusals = [], []
    for e in _lines(out / "stdout.txt"):
        part = e.get("part") or {}
        if e.get("type") != "tool_use" or part.get("type") != "tool":
            continue
        st = part.get("state") or {}
        inp = st.get("input") or {}
        if st.get("status") == "error":
            err = json.dumps(st.get("error") or "").lower()
            if any(w in err for w in DENY_WORDS):
                refusals.append({"tool": part.get("tool"), "target": json.dumps(inp)[:160], "why": err[:200]})
        if part.get("tool") in ("bash", "shell") and isinstance(inp.get("command"), str):
            c = {"tool": part["tool"], "command": inp["command"], "status": st.get("status")}
            err = json.dumps(st.get("error") or st.get("metadata") or "")
            if st.get("status") == "error" and any(w in err.lower() for w in DENY_WORDS):
                c["ran"] = False
            cmds.append(c)
    return cmds, {"refused_tool_calls": refusals}


def _goose(out):
    cmds, results, requests = [], {}, {}
    for e in _lines(out / "stdout.txt"):
        msg = e.get("message") or {}
        for c in msg.get("content") or []:
            if c.get("type") == "toolRequest":
                requests[c.get("id")] = (c.get("toolCall") or {}).get("value") or {}
                call = (c.get("toolCall") or {}).get("value") or {}
                name = call.get("name", "")
                args = _args(call.get("arguments"))
                if name.split("__")[-1] in ("shell", "bash") and isinstance(args.get("command"), str):
                    cmds.append({"tool": name, "command": args["command"], "id": c.get("id")})
            elif c.get("type") == "toolResponse":
                results[c.get("id")] = c.get("toolResult") or {}
    refusals = []
    for rid, r in results.items():
        blob = json.dumps(r).lower()
        if r.get("status") == "error" and any(w in blob for w in DENY_WORDS):
            q = requests.get(rid) or {}
            refusals.append({"tool": q.get("name"), "target": json.dumps(q.get("arguments"))[:160], "why": blob[:200]})
    refused_ids = {rid for rid, r in results.items() if r.get("status") == "error"
                   and any(w in json.dumps(r).lower() for w in DENY_WORDS)}
    for c in cmds:
        if c.get("id") in refused_ids:
            c["ran"] = False
    return cmds, {"refused_tool_calls": refusals}


def _qwen(out):
    """Qwen's stream-json: tool_use blocks named run_shell_command, or wrapped in its
    `tool_call` bridge ({name, arguments}); a tool_result with is_error whose text says
    the call was refused or declined was not run; the final result lists
    permission_denials."""
    cmds, denied, results = [], [], {}
    for e in _lines(out / "stdout.txt"):
        if e.get("type") == "result":
            denied = e.get("permission_denials") or []
        msg = e.get("message") or {}
        content = msg.get("content") if isinstance(msg.get("content"), list) else []
        for b in content:
            if b.get("type") == "tool_use":
                name, inp = b.get("name"), b.get("input") or {}
                if name == "tool_call":
                    name, inp = inp.get("name"), _args(inp.get("arguments"))
                if name in ("run_shell_command", "shell", "bash") and isinstance(inp.get("command"), str):
                    cmds.append({"tool": name, "command": inp["command"], "id": b.get("id")})
            elif b.get("type") == "tool_result":
                results[b.get("tool_use_id")] = b
    denied_ids = {d.get("tool_use_id") for d in denied if isinstance(d, dict)}
    refused_ids = {i for i, r in results.items() if r.get("is_error") and any(
        w in json.dumps(r.get("content", "")).lower() for w in DENY_WORDS + ("not registered",))}
    for c in cmds:
        if c.get("id") in denied_ids or c.get("id") in refused_ids:
            c["ran"] = False
    refusals = [{"tool": "?", "target": i, "why": json.dumps(results[i].get("content", ""))[:200]}
                for i in sorted(refused_ids | (denied_ids & set(results)))]
    return cmds, {"permission_denials": denied, "refused_tool_calls": refusals}


def _mini(out):
    p = out / "post" / "harness" / "g1-mini-traj.json"
    if not p.exists():
        return [], {"missing": str(p)}
    traj = json.loads(p.read_text())
    cmds = []
    for m in traj.get("messages") or []:
        if m.get("role") != "assistant":
            continue
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function") or {}
            args = _args(fn.get("arguments"))
            if isinstance(args.get("command"), str):
                cmds.append({"tool": fn.get("name"), "command": args["command"]})
    return cmds, {}


def _gnomon(out):
    """gnomon's own hash-chained audit trail (.gnomon-audit/task-*.jsonl, in the repo).
    With the scaffolded `record = "metadata"` a bash call's `target` is the command
    cut to ~70 characters and an ellipsis -- the shim gets what the trail keeps."""
    tar = out / "post" / "final.tar"
    cmds, refusals = [], []
    if not tar.exists():
        return [], {"missing": "final.tar"}
    with tarfile.open(tar) as tf:
        for m in tf.getmembers():
            if "/.gnomon-audit/task-" in m.name and m.name.endswith(".jsonl") and m.isfile():
                for line in tf.extractfile(m).read().decode("utf-8", "replace").splitlines():
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if r.get("kind") != "tool_call":
                        continue
                    refused = r.get("bucket") == "refusal"
                    if refused:
                        refusals.append({"tool": r.get("tool"), "target": r.get("target"), "why": r.get("summary")})
                    if r.get("tool") == "bash" and isinstance(r.get("target"), str):
                        c = {"tool": "bash", "command": r["target"].rstrip("\u2026"),
                             "truncated": r["target"].endswith("\u2026")}
                        if refused:
                            c["ran"] = False
                        cmds.append(c)
    return cmds, {"refused_tool_calls": refusals}


def commands(arm: str, out: Path):
    try:
        return {"opencode": _opencode, "goose": _goose, "qwen": _qwen, "mini": _mini, "gnomon": _gnomon}[arm](out)
    except Exception as e:  # the shim must never stop a trial
        return [], {"shim_error": repr(e)}


def claude_code_jsonl(cmds) -> str:
    """One assistant record per command; a refused one is followed by a user record
    carrying toolDenialKind, which is how Claude Code marks a call it did not run."""
    lines = [json.dumps({"type": "user", "message": {"role": "user", "content": "g1 shim"}})]
    for i, c in enumerate(cmds):
        tid = f"g1shim_{i}"
        lines.append(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": c["command"]}}]}}))
        if c.get("ran") is False:
            lines.append(json.dumps({"type": "user", "toolDenialKind": "harness", "message": {"role": "user",
                                     "content": [{"type": "tool_result", "tool_use_id": tid, "content": "refused"}]}}))
    return "\n".join(lines) + "\n"
