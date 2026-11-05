#!/usr/bin/env python3
"""GBS-OVERHEAD 0.2 (draft) runner: opencode v2.2.5 beside gnomon v0.4.2, cold-process, S0 and S1.

Derived from benchmarks/results/gbs-2026-11-04/overhead/overhead.py (the 0.1 run on gnomon v0.4.1):
the fake model, the S1 script, the repository generator, the trial loop, the CPU accounting (process
tree under a child subreaper, tool children included: OVH-2) and the validity rule are that file's.
New here:
  - an opencode arm, with the S1 tool map (read/grep/edit/bash -> read/grep/edit/shell, opencode's
    argument names), and F0-oc, the wire floor replaying opencode's own request bodies (OVH-8);
  - auxiliary requests (a request that offers no tools, e.g. opencode's session-title request) are
    answered, logged and counted apart from the scripted round-trips, never a validity failure;
  - N-bun: the same null harness on opencode's own runtime (the Bun embedded in its binary, run with
    BUN_BE_BUN=1), beside N on Node, gnomon's runtime (OVH-5);
  - everything runs inside the gbs05 container (--network none), the harnesses installed in the image.

  python3 -I overhead.py main  --out /out/main.jsonl --rounds 20
  python3 -I overhead.py smoke --out /out/smoke.jsonl --rounds 1     # not a result
Run as: nice -n 19 python3 -I overhead.py ... inside `docker run --cpuset-cpus 5-9,15-19` (X925 cores).
"""
import argparse, ctypes, hashlib, http.server, json, os, random, re, resource, shutil, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("GBS_WORK", "/tmp/gbs-overhead")
# where the image installed the natives: the image user's own HOME, read before any trial changes HOME
NATIVES = os.environ.get("GBS_NATIVES") or os.path.join(os.path.expanduser("~"), ".local/share/gnomon/bin")
EXPECT = {"gnomon": "gnomon/0.4.2+v0.4.2-2498d16", "opencode": "opencode v2.2.5"}
LOAD_THRESHOLD = 0.25 * os.cpu_count()

# ── Scenarios (verbatim from the 0.1 runner) ──────────────────────────────────
SRC = {"src/a.txt": "alpha MARK_A TODO\nline two\n", "src/b.txt": "beta MARK_B\nline two\n", "src/c.txt": "gamma MARK_C\nline two\n"}
S1 = [("read", {"path": "src/a.txt"}, "MARK_A"), ("grep", {"pattern": "TODO", "path": "src"}, "MARK_A"),
      ("edit", {"path": "src/a.txt", "old_text": "alpha", "new_text": "ALPHA"}, None), ("bash", {"command": "true"}, None),
      ("read", {"path": "src/b.txt"}, "MARK_B"), ("grep", {"pattern": "beta", "path": "src"}, "MARK_B"),
      ("edit", {"path": "src/b.txt", "old_text": "beta", "new_text": "BETA"}, None), ("bash", {"command": "true"}, None),
      ("read", {"path": "src/c.txt"}, "MARK_C"), ("edit", {"path": "src/c.txt", "old_text": "gamma", "new_text": "GAMMA"}, None)]
SCEN = {"S0": {"prompt": "Reply with OK.", "script": [], "final": "OK"},
        "S1": {"prompt": "Do the scripted edits in src/, then reply DONE.", "script": S1, "final": "DONE"}}

# ── Tool maps: the abstract S1 actions in each harness's own names and arguments (published) ──
def tm_identity(tool, a): return tool, a
def tm_opencode(tool, a):
    if tool == "read": return "read", {"path": a["path"]}
    if tool == "grep": return "grep", {"pattern": a["pattern"], "path": a["path"]}
    if tool == "edit": return "edit", {"path": a["path"], "oldString": a["old_text"], "newString": a["new_text"]}
    if tool == "bash": return "shell", {"command": a["command"]}
    raise KeyError(tool)
TOOLMAP = {"gnomon": tm_identity, "gnomon-gov-off": tm_identity, "N": tm_identity, "N-bun": tm_identity, "opencode": tm_opencode, "opencode-fast": tm_opencode}

def expected_hash(scen):
    files = dict(SRC)
    for tool, a, _ in SCEN[scen]["script"]:
        if tool == "edit": files[a["path"]] = files[a["path"]].replace(a["old_text"], a["new_text"], 1)
    return tree_hash_of(files)

def tree_hash_of(files):
    h = hashlib.sha256()
    for k in sorted(files): h.update(k.encode() + b"\0" + files[k].encode() + b"\0")
    return h.hexdigest()

def repo_hash(root):
    return tree_hash_of({k: open(os.path.join(root, k)).read() for k in SRC})

# ── Fake model ───────────────────────────────────────────────────────────────
class Model:
    def __init__(self):
        self.lock = threading.Lock(); self.reset("S0", 0)
    def reset(self, scen, d, record=None, toolmap=tm_identity):
        with self.lock:
            self.scen, self.d, self.log, self.record, self.toolmap = scen, d, [], record, toolmap

def text_of(c):
    if isinstance(c, str): return c
    if isinstance(c, list): return "".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *a): pass
    def do_GET(self):
        b = b'{"object":"list","data":[{"id":"fake","object":"model"}]}'
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        t = time.monotonic()
        n = int(self.headers.get("content-length", 0)); raw = self.rfile.read(n)
        req = json.loads(raw); M = self.server.model
        msgs = req.get("messages", [])
        aux = not req.get("tools")  # no tools offered: not a scripted round-trip (e.g. a session-title request)
        last_user = max([i for i, m in enumerate(msgs) if m.get("role") == "user"] or [-1])
        k = sum(1 for m in msgs[last_user + 1:] if m.get("role") == "tool")  # steps since this turn's prompt
        last_tool = next((text_of(m.get("content")) for m in reversed(msgs) if m.get("role") == "tool"), None)
        with M.lock:
            script, final, d, tmap = SCEN[M.scen]["script"], SCEN[M.scen]["final"], M.d, M.toolmap
            M.log.append({"t": t, "bytes": n, "k": k, "aux": aux, "stream": bool(req.get("stream")), "last_tool": (last_tool or "")[:600],
                          "tools_offered": [x.get("function", {}).get("name") for x in req.get("tools", []) or []]})
            if M.record is not None: M.record.append(raw.decode())
        time.sleep(d / 1000)
        usage = {"prompt_tokens": n // 4, "completion_tokens": 8, "total_tokens": n // 4 + 8}
        if not aux and k < len(script):
            tool, args, _ = script[k]
            name, margs = tmap(tool, args)
            call = {"id": f"call_{k}", "type": "function", "function": {"name": name, "arguments": json.dumps(margs)}}
            msg, finish = {"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls"
        else:
            msg, finish = {"role": "assistant", "content": ("GBS overhead" if aux else final)}, "stop"
        if req.get("stream"):
            self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
            delta = {"role": "assistant"}
            if "tool_calls" in msg: delta["tool_calls"] = [dict(msg["tool_calls"][0], index=0)]
            else: delta["content"] = msg["content"]
            for ch in ({"choices": [{"index": 0, "delta": delta}]}, {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}, {"choices": [], "usage": usage}):
                self.wfile.write(b"data: " + json.dumps(ch).encode() + b"\n\n")
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            b = json.dumps({"id": "x", "object": "chat.completion", "model": req.get("model"), "choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": usage}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

def start_model():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler); srv.model = Model(); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/v1/chat/completions"

# ── Repositories (the 0.1 generator, seed 20261104; only the 0-file repo is used here) ──
GITIGNORE = "build/\n.gnomon-sessions/\n.gnomon-audit/\n.gnomon-out/\n.gnomon-jobs/\n.gnomon-loops/\n.gnomon-shadow/\n.gnomon-skills/\n.gnomon-trials/\n"
def git(cwd, *a): subprocess.run(["git", "-c", "gc.auto=0", "-c", "user.name=gbs", "-c", "user.email=gbs@example.invalid", "-c", "init.defaultBranch=main", *a], cwd=cwd, check=True, capture_output=True)

def generate(root, files, use_git, seed=20261104):
    rnd = random.Random(seed * 1_000_003 + files)
    os.makedirs(root)
    for i in range(files):
        p = os.path.join(root, "gen", f"d{i // 500:03d}", f"f{i:05d}.txt"); os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").write(f"file {i} {rnd.getrandbits(64):016x}\n")
    for k, v in SRC.items(): os.makedirs(os.path.join(root, os.path.dirname(k)), exist_ok=True); open(os.path.join(root, k), "w").write(v)
    open(os.path.join(root, ".gitignore"), "w").write(GITIGNORE)
    for i in range(100): os.makedirs(os.path.join(root, "build"), exist_ok=True); open(os.path.join(root, "build", f"o{i}.bin"), "w").write("x" * 64)
    if use_git:
        git(root, "init", "-q"); git(root, "config", "gc.auto", "0"); git(root, "add", "-A"); git(root, "commit", "-qm", "gbs fixture")
    os.makedirs(os.path.join(root, "untracked"), exist_ok=True)
    for i in range(10): open(os.path.join(root, "untracked", f"u{i}.txt"), "w").write(f"u{i}\n")

def env_for(home, cwd=None, arm=None):
    e = {k: v for k, v in os.environ.items() if not k.startswith(("GNOMON_", "OPENCODE_", "BUN_"))}
    # The natives stay where the image installed them, whatever HOME a trial has (as GNOMON_BIN_OVERRIDE did in 0.1).
    e.update(HOME=home, GNOMON_NO_UPDATE_CHECK="1", OPENCODE_DISABLE_AUTOUPDATE="1", GNOMON_BIN_OVERRIDE=NATIVES)
    if arm in ("opencode", "opencode-fast") and cwd:
        e.update(PWD=cwd, OPENCODE_CONFIG=os.path.join(cwd, "opencode.json"))  # V2 takes its directory from $PWD (G2b)
    if arm in ("N-bun", "F0-oc"): e["BUN_BE_BUN"] = "1"
    os.makedirs(home, exist_ok=True); return e

def set_toml(path, section, key, value):
    t = open(path).read()
    m = re.search(r"^\[" + re.escape(section) + r"\]\s*$", t, re.M)
    if not m: t += f"\n[{section}]\n{key} = {value}\n"
    else:
        end = re.search(r"^\[", t[m.end():], re.M); body_end = m.end() + (end.start() if end else len(t) - m.end())
        body = t[m.end():body_end]
        if re.search(r"^" + re.escape(key) + r"\s*=", body, re.M): body = re.sub(r"^" + re.escape(key) + r"\s*=.*$", f"{key} = {value}", body, count=1, flags=re.M)
        else: body = f"\n{key} = {value}" + body
        t = t[:m.end()] + body + t[body_end:]
    open(path, "w").write(t)

def setup_gnomon(root, url, home, arm="gnomon"):
    if not os.path.exists(os.path.join(root, ".gnomon")):
        subprocess.run(["gnomon", "init"], cwd=root, env=env_for(home), check=True, capture_output=True)
    g = os.path.join(root, ".gnomon")
    set_toml(f"{g}/config.toml", "endpoints.local", "url", json.dumps(url)); set_toml(f"{g}/config.toml", "endpoints.local", "kind", '"openai"')
    if arm == "gnomon-gov-off":  # the 0.1 run's gov-off arm: audit off, sandbox off, approval never
        set_toml(f"{g}/config.toml", "audit", "enabled", "false")
        set_toml(f"{g}/config.toml", "defaults", "sandbox", '"off"'); set_toml(f"{g}/config.toml", "defaults", "approval", '"never"')
        set_toml(f"{g}/policy.toml", "approval", "gate", '"never"'); set_toml(f"{g}/policy.toml", "sandbox", "level", '"off"')
    return subprocess.run(["gnomon", "surface", "hash"], cwd=root, env=env_for(home), capture_output=True, text=True).stdout.strip()

def opencode_config(url, fast=False):
    """opencode's shipped defaults plus a provider pointed at the fake model, in V2's own format.
    fast: best-effort fast (OVH-4) = default + `snapshot: false`, the documented switch for its git
    snapshots (undo tracking); its permissions are untouched."""
    c = {"$schema": "https://opencode.ai/config.json", "model": {"providerID": "gbs", "model": "fake"},
            "update": "disable", "share": "disabled",
            "providers": {"gbs": {"name": "gbs fake", "package": "aisdk:@ai-sdk/openai-compatible",
                                  "settings": {"apiKey": "none", "baseURL": url.replace("/chat/completions", "")},
                                  "models": {"fake": {"name": "fake"}}}}}
    if fast: c["snapshot"] = False
    return c

def setup_opencode(root, url, fast=False):
    cfg = opencode_config(url, fast)
    open(os.path.join(root, "opencode.json"), "w").write(json.dumps(cfg, indent=2) + "\n")
    tmpl = opencode_config("http://<endpoint>/v1/chat/completions", fast)
    return hashlib.sha256((json.dumps(tmpl, sort_keys=True) + "\0" + " ".join(OC_FLAGS)).encode()).hexdigest()

def reset_repo(root):
    for k, v in SRC.items(): open(os.path.join(root, k), "w").write(v)
    for n in os.listdir(root):
        if n.startswith(".gnomon-"): shutil.rmtree(os.path.join(root, n))

# ── One trial (the 0.1 accounting) ──────────────────────────────────────────────
libc = ctypes.CDLL(None, use_errno=True)
def become_subreaper(): libc.prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER

def reap_orphans(wait_s=0.5):
    n, deadline = 0, time.monotonic() + wait_s
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return n
        if pid == 0:
            if time.monotonic() > deadline: return n
            time.sleep(0.01); continue
        n += 1

def trial(srv, cmd, cwd, env, scen, d, record=None, toolmap=tm_identity):
    srv.model.reset(scen, d, record, toolmap)
    out_p, err_p = os.path.join(WORK, "last.out"), os.path.join(WORK, "last.err")
    load = os.getloadavg()[0]
    r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    with open(out_p, "w") as fo, open(err_p, "w") as fe:
        t0 = time.monotonic(); p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=fo, stderr=fe)
        _, status, ru = os.wait4(p.pid, 0); t1 = time.monotonic()
    p.returncode = os.waitstatus_to_exitcode(status)
    orphans = reap_orphans(0.2)
    r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    log = list(srv.model.log)
    main_log = [x for x in log if not x["aux"]]
    cpu = ((r1.ru_utime - r0.ru_utime) + (r1.ru_stime - r0.ru_stime)) * 1000
    wall = (t1 - t0) * 1000
    rec = {"exit": p.returncode, "wall_ms": round(wall, 2), "cpu_ms": round(cpu, 2), "cpu_user_ms": round((r1.ru_utime - r0.ru_utime) * 1000, 2),
           "cpu_sys_ms": round((r1.ru_stime - r0.ru_stime) * 1000, 2), "rss_mb": round(ru.ru_maxrss / 1024, 1),
           "requests": len(main_log), "aux_requests": len(log) - len(main_log),
           "first_req_ms": round((min(x["t"] for x in log) - t0) * 1000, 2) if log else None,
           "harness_wall_ms": round(wall - len(main_log) * d, 2), "bytes_total": sum(x["bytes"] for x in main_log),
           "aux_bytes_total": sum(x["bytes"] for x in log if x["aux"]),
           "bytes_per_req": round(sum(x["bytes"] for x in main_log) / max(1, len(main_log)), 1), "stream": main_log[0]["stream"] if main_log else None,
           "tools_offered": main_log[0]["tools_offered"] if main_log else None,
           "load1": load, "load_flag": load > LOAD_THRESHOLD, "orphans_reaped": orphans}
    script = SCEN[scen]["script"]; problems = []
    if p.returncode != 0: problems.append(f"exit {p.returncode}")
    if [x["k"] for x in main_log] != list(range(len(script) + 1)): problems.append(f"request sequence {[x['k'] for x in main_log]}")
    for i, (_, _, want) in enumerate(script):
        if i + 1 < len(main_log):
            got = main_log[i + 1]["last_tool"]
            if want and want not in got: problems.append(f"tool result {i} lacks {want}")
            if re.search(r"refus|denied|not allowed|blocked|permission\.rejected", got, re.I): problems.append(f"tool result {i} refused: {got[:80]}")
    if repo_hash(cwd) != expected_hash(scen): problems.append("final repository hash differs")
    rec["valid"] = not problems; rec["problems"] = problems
    rec["stderr_tail"] = open(err_p, errors="replace").read()[-300:] if problems else ""
    return rec

# ── Arms ─────────────────────────────────────────────────────────────────────
OC_FLAGS = ["run", "--standalone"]   # cold-process: a private server per invocation, no background service
def arm_cmd(arm, url, scen, bodies=None):
    if arm in ("gnomon", "gnomon-gov-off"): return ["gnomon", "task", SCEN[scen]["prompt"], "--json", "--yes", "--trust"]
    if arm in ("opencode", "opencode-fast"): return ["opencode", *OC_FLAGS, SCEN[scen]["prompt"]]
    if arm == "N": return ["node", os.path.join(HERE, "null_harness.mjs"), url, SCEN[scen]["prompt"]]
    if arm == "N-bun": return ["opencode", os.path.join(HERE, "null_harness.mjs"), url, SCEN[scen]["prompt"]]
    if arm == "F0": return ["node", os.path.join(HERE, "wire_floor.mjs"), url, bodies]
    if arm == "F0-oc": return ["opencode", os.path.join(HERE, "wire_floor.mjs"), url, bodies]  # on opencode's Bun (OVH-5)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--out", required=True); ap.add_argument("--rounds", type=int, default=20)
    a = ap.parse_args()
    become_subreaper(); os.makedirs(WORK, exist_ok=True)
    vg = subprocess.run(["gnomon", "--version"], env=env_for(os.path.join(WORK, "home-gnomon")), capture_output=True, text=True).stdout.strip()
    vo = subprocess.run(["opencode", "--version"], env=env_for(os.path.join(WORK, "home-opencode")), capture_output=True, text=True).stdout.strip()
    assert vg == EXPECT["gnomon"], f"wrong gnomon build {vg}"; assert vo == EXPECT["opencode"], f"wrong opencode build {vo}"
    srv, url = start_model()
    out = open(a.out, "a")
    def emit(r): out.write(json.dumps(r) + "\n"); out.flush()
    meta = {"meta": True, "mode": a.mode, "url": url, "builds": {"gnomon": vg, "opencode": vo}, "node": subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip(),
            "bun_in_opencode": subprocess.run(["opencode", "--version"], env=dict(env_for(os.path.join(WORK, "home-x")), BUN_BE_BUN="1"), capture_output=True, text=True).stdout.strip(),
            "affinity": sorted(os.sched_getaffinity(0)), "nice": os.nice(0), "load_threshold": LOAD_THRESHOLD, "cpu_count": os.cpu_count(),
            "toolmap_opencode": {t: list(tm_opencode(t, {"path": "P", "pattern": "Q", "old_text": "O", "new_text": "N", "command": "C"})) for t in ("read", "grep", "edit", "bash")},
            "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    base0 = os.path.join(WORK, "repo-0-git")
    if not os.path.exists(base0): generate(base0, 0, True)
    arms = ["gnomon", "gnomon-gov-off", "opencode", "opencode-fast", "N", "N-bun", "F0", "F0-oc"]
    roots, hashes = {}, {}
    for arm in arms:
        if arm.startswith("F0"): continue
        r = os.path.join(WORK, f"r0-{arm}")
        if not os.path.exists(r): shutil.copytree(base0, r, symlinks=True)
        if arm.startswith("gnomon"): hashes[arm] = setup_gnomon(r, url, os.path.join(WORK, f"home-{arm}"), arm)
        if arm.startswith("opencode"): hashes[arm] = setup_opencode(r, url, fast=arm == "opencode-fast")
        roots[arm] = r
    meta["config_hashes"] = hashes; meta["opencode_flags"] = OC_FLAGS
    meta["opencode_config_templates"] = {a: opencode_config("http://<endpoint>/v1/chat/completions", a == "opencode-fast") for a in ("opencode", "opencode-fast")}
    emit(meta)
    cells = [("S0", 0), ("S0", 250), ("S1", 0), ("S1", 250)]
    rec_for = {"gnomon": "F0", "opencode": "F0-oc"}
    bodies = {}
    for scen, d in cells:  # warm-up, discarded: warms the file cache and records each F0's bodies
        for arm in arms:
            if arm.startswith("F0"): continue
            reset_repo(roots[arm]); rec = [] if arm in rec_for else None
            r = trial(srv, arm_cmd(arm, url, scen), roots[arm], env_for(os.path.join(WORK, f"home-{arm}"), roots[arm], arm), scen, 0, rec, TOOLMAP[arm])
            emit(dict(r, warmup=True, scenario=scen, d=d, arm=arm))
            if arm in rec_for:
                f = os.path.join(WORK, f"bodies-{rec_for[arm]}-{scen}.jsonl"); open(f, "w").write("\n".join(rec) + "\n"); bodies[(rec_for[arm], scen)] = f
    for rnd in range(a.rounds):
        for scen, d in cells:
            order = arms[rnd % len(arms):] + arms[:rnd % len(arms)]
            for arm in order:
                cwd = roots.get(arm, roots["gnomon"])
                if not arm.startswith("F0"): reset_repo(cwd)
                home = os.path.join(WORK, f"home-{arm}")
                r = trial(srv, arm_cmd(arm, url, scen, bodies.get((arm, scen))), cwd, env_for(home, cwd, arm), scen, d, None, TOOLMAP.get(arm, tm_identity))
                if arm.startswith("F0"):  # F0 replays bodies; the repository and script checks do not apply
                    nb = sum(1 for l in open(bodies[(arm, scen)]) if l.strip())
                    r["valid"] = r["exit"] == 0 and r["requests"] + r["aux_requests"] == nb; r["problems"] = [] if r["valid"] else ["replay incomplete"]
                r.update(round=rnd, scenario=scen, d=d, arm=arm, condition="cold-process", t_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                emit(r)
            print(f"round {rnd} {scen} d={d} done", file=sys.stderr, flush=True)
        if a.mode == "smoke": break

if __name__ == "__main__":
    main()
