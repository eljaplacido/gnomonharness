#!/usr/bin/env python3
"""GBS-OVERHEAD 0.1 runner, gnomon v0.4.1 (see PRE-REGISTRATION.md).

One process: a scripted fake model (OpenAI chat-completions, SSE and one-body, fixed delay d,
every request logged) on an ephemeral 127.0.0.1 port, and the trial loop. Harnesses run as
child processes; this process is a child subreaper so that anything a harness detaches is
reaped here and its CPU counted.

  python3 overhead.py main   --out raw/trials.jsonl --rounds 20        # S0, S1 x d in {0,250}
  python3 overhead.py s3     --out raw/s3.jsonl --rounds 10            # S3 sizes, git and no-git
  python3 overhead.py home   --out raw/coldhome.jsonl --rounds 20      # cold-home, S1, default
  python3 overhead.py strace --out raw/spawns.jsonl --rounds 3         # spawn counts (inferred)
  python3 overhead.py smoke  --out raw/smoke/smoke.jsonl --rounds 1    # not a result

Run as: nice -n 19 taskset -c 5-9,15-19 python3 -I overhead.py ...
Needs GBS_SCRATCH (see ../common/INSTALL.md); the work tree goes under $GBS_SCRATCH/overhead.
"""
import argparse, ctypes, hashlib, http.server, json, os, random, re, resource, shutil, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.environ["GBS_SCRATCH"]
WORK = os.path.join(SCRATCH, "overhead")
PREFIX = os.path.join(SCRATCH, "prefix")
NATIVES = os.path.join(SCRATCH, "home/.local/share/gnomon/bin")
EXPECT = "gnomon/0.4.1+v0.4.1-c511b81"
LOAD_THRESHOLD = 0.25 * os.cpu_count()

# ── Scenarios ────────────────────────────────────────────────────────────────
SRC = {"src/a.txt": "alpha MARK_A TODO\nline two\n", "src/b.txt": "beta MARK_B\nline two\n", "src/c.txt": "gamma MARK_C\nline two\n"}
S1 = [("read", {"path": "src/a.txt"}, "MARK_A"), ("grep", {"pattern": "TODO", "path": "src"}, "MARK_A"),
      ("edit", {"path": "src/a.txt", "old_text": "alpha", "new_text": "ALPHA"}, None), ("bash", {"command": "true"}, None),
      ("read", {"path": "src/b.txt"}, "MARK_B"), ("grep", {"pattern": "beta", "path": "src"}, "MARK_B"),
      ("edit", {"path": "src/b.txt", "old_text": "beta", "new_text": "BETA"}, None), ("bash", {"command": "true"}, None),
      ("read", {"path": "src/c.txt"}, "MARK_C"), ("edit", {"path": "src/c.txt", "old_text": "gamma", "new_text": "GAMMA"}, None)]
SCEN = {"S0": {"prompt": "Reply with OK.", "script": [], "final": "OK"},
        "S1": {"prompt": "Do the scripted edits in src/, then reply DONE.", "script": S1, "final": "DONE"}}
EDITED_FILES = 3  # S1 changes src/a.txt, src/b.txt, src/c.txt

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
    def reset(self, scen, d, record=None):
        with self.lock:
            self.scen, self.d, self.log, self.record = scen, d, [], record

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
        last_user = max([i for i, m in enumerate(msgs) if m.get("role") == "user"] or [-1])
        k = sum(1 for m in msgs[last_user + 1:] if m.get("role") == "tool")  # steps since this turn's prompt
        last_tool = next((text_of(m.get("content")) for m in reversed(msgs) if m.get("role") == "tool"), None)
        with M.lock:
            script, final, d = SCEN[M.scen]["script"], SCEN[M.scen]["final"], M.d
            M.log.append({"t": t, "bytes": n, "k": k, "stream": bool(req.get("stream")), "last_tool": (last_tool or "")[:600],
                          "tools_offered": [x.get("function", {}).get("name") for x in req.get("tools", []) or []]})
            if M.record is not None: M.record.append(raw.decode())
        time.sleep(d / 1000)
        usage = {"prompt_tokens": n // 4, "completion_tokens": 8, "total_tokens": n // 4 + 8}
        if k < len(script):
            tool, args, _ = script[k]
            call = {"id": f"call_{k}", "type": "function", "function": {"name": tool, "arguments": json.dumps(args)}}
            msg, finish = {"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls"
        else:
            msg, finish = {"role": "assistant", "content": final}, "stop"
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

# ── Repositories ─────────────────────────────────────────────────────────────
GITIGNORE = "build/\n.gnomon-sessions/\n.gnomon-audit/\n.gnomon-out/\n.gnomon-jobs/\n.gnomon-loops/\n.gnomon-shadow/\n.gnomon-skills/\n.gnomon-trials/\n"
def git(cwd, *a): subprocess.run(["git", "-c", "user.name=gbs", "-c", "user.email=gbs@example.invalid", "-c", "init.defaultBranch=main", *a], cwd=cwd, check=True, capture_output=True)

def generate(root, files, use_git, seed=20261104):
    """Seeded tree: `files` tracked files under gen/, the three src/ files, 10 untracked files,
    an ignored build/ with 100 files, one commit. Deterministic for (files, seed)."""
    rnd = random.Random(seed * 1_000_003 + files)
    os.makedirs(root)
    for i in range(files):
        p = os.path.join(root, "gen", f"d{i // 500:03d}", f"f{i:05d}.txt"); os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").write(f"file {i} {rnd.getrandbits(64):016x}\n")
    for k, v in SRC.items(): os.makedirs(os.path.join(root, os.path.dirname(k)), exist_ok=True); open(os.path.join(root, k), "w").write(v)
    open(os.path.join(root, ".gitignore"), "w").write(GITIGNORE)
    for i in range(100): os.makedirs(os.path.join(root, "build"), exist_ok=True); open(os.path.join(root, "build", f"o{i}.bin"), "w").write("x" * 64)
    if use_git:
        git(root, "init", "-q"); git(root, "add", "-A"); git(root, "commit", "-qm", "gbs fixture")
    os.makedirs(os.path.join(root, "untracked"), exist_ok=True)
    for i in range(10): open(os.path.join(root, "untracked", f"u{i}.txt"), "w").write(f"u{i}\n")

def env_for(home):
    e = {k: v for k, v in os.environ.items() if not k.startswith("GNOMON_")}
    e.update(HOME=home, PATH=f"{PREFIX}/bin:" + os.environ["PATH"], GNOMON_NO_UPDATE_CHECK="1", GNOMON_BIN_OVERRIDE=NATIVES)
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

ARMS_G = ("default", "audit-off", "gov-off")
def setup_gnomon(root, arm, url, home):
    if not os.path.exists(os.path.join(root, ".gnomon")):
        subprocess.run(["gnomon", "init"], cwd=root, env=env_for(home), check=True, capture_output=True)
    g = os.path.join(root, ".gnomon")
    set_toml(f"{g}/config.toml", "endpoints.local", "url", json.dumps(url)); set_toml(f"{g}/config.toml", "endpoints.local", "kind", '"openai"')
    if arm in ("audit-off", "gov-off"): set_toml(f"{g}/config.toml", "audit", "enabled", "false")
    if arm == "gov-off":
        set_toml(f"{g}/config.toml", "defaults", "sandbox", '"off"'); set_toml(f"{g}/config.toml", "defaults", "approval", '"never"')
        set_toml(f"{g}/policy.toml", "approval", "gate", '"never"'); set_toml(f"{g}/policy.toml", "sandbox", "level", '"off"')
    h = subprocess.run(["gnomon", "surface", "hash"], cwd=root, env=env_for(home), capture_output=True, text=True).stdout.strip()
    return h

def reset_repo(root):
    for k, v in SRC.items(): open(os.path.join(root, k), "w").write(v)
    for n in os.listdir(root):
        if n.startswith(".gnomon-"): shutil.rmtree(os.path.join(root, n))

# ── One trial ────────────────────────────────────────────────────────────────
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

def trial(srv, cmd, cwd, env, scen, d, record=None, strace=None):
    srv.model.reset(scen, d, record)
    out_p, err_p = os.path.join(WORK, "last.out"), os.path.join(WORK, "last.err")
    if strace: cmd = ["strace", "-f", "-qq", "-e", "trace=execve", "-o", strace] + cmd
    load = os.getloadavg()[0]
    r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    with open(out_p, "w") as fo, open(err_p, "w") as fe:
        t0 = time.monotonic(); p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=fo, stderr=fe)
        _, status, ru = os.wait4(p.pid, 0); t1 = time.monotonic()
    p.returncode = os.waitstatus_to_exitcode(status)
    orphans = reap_orphans(0.2)
    r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    log = list(srv.model.log)
    cpu = ((r1.ru_utime - r0.ru_utime) + (r1.ru_stime - r0.ru_stime)) * 1000
    turns = max(1, len(log)); wall = (t1 - t0) * 1000
    rec = {"exit": p.returncode, "wall_ms": round(wall, 2), "cpu_ms": round(cpu, 2), "cpu_user_ms": round((r1.ru_utime - r0.ru_utime) * 1000, 2),
           "cpu_sys_ms": round((r1.ru_stime - r0.ru_stime) * 1000, 2), "rss_mb": round(ru.ru_maxrss / 1024, 1),
           "requests": len(log), "first_req_ms": round((log[0]["t"] - t0) * 1000, 2) if log else None,
           "harness_wall_ms": round(wall - len(log) * d, 2), "bytes_total": sum(x["bytes"] for x in log),
           "bytes_per_req": round(sum(x["bytes"] for x in log) / turns, 1), "stream": log[0]["stream"] if log else None,
           "load1": load, "load_flag": load > LOAD_THRESHOLD, "orphans_reaped": orphans}
    # validity (§6)
    script = SCEN[scen]["script"]; problems = []
    if p.returncode != 0: problems.append(f"exit {p.returncode}")
    if [x["k"] for x in log] != list(range(len(script) + 1)): problems.append(f"request sequence {[x['k'] for x in log]}")
    for i, (_, _, want) in enumerate(script):
        if i + 1 < len(log):
            got = log[i + 1]["last_tool"]
            if want and want not in got: problems.append(f"tool result {i} lacks {want}")
            if re.search(r"refus|denied|not allowed|blocked", got, re.I): problems.append(f"tool result {i} refused: {got[:80]}")
    if repo_hash(cwd) != expected_hash(scen): problems.append("final repository hash differs")
    stdout = open(out_p).read()
    try:
        tj = json.loads(stdout)
        rec["stop_reason"] = tj.get("stop_reason"); rec["tree_delta_files"] = tj.get("counters", {}).get("tree_delta", {}).get("files")
        rec["gnomon_duration_ms"] = tj.get("volatile", {}).get("duration_ms")
    except Exception:
        pass
    rec["valid"] = not problems; rec["problems"] = problems
    return rec

# ── Arms ─────────────────────────────────────────────────────────────────────
def arm_cmd(arm, url, scen, bodies=None):
    if arm in ARMS_G: return ["gnomon", "task", SCEN[scen]["prompt"], "--json", "--yes", "--trust"]
    if arm == "N": return ["node", os.path.join(HERE, "null_harness.mjs"), url, SCEN[scen]["prompt"]]
    if arm == "F0": return ["node", os.path.join(HERE, "wire_floor.mjs"), url, bodies]

def build_arms(base, arms, url, tag):
    roots, hashes = {}, {}
    for a in arms:
        if a == "F0": continue
        r = os.path.join(WORK, f"{tag}-{a}")
        if not os.path.exists(r):
            shutil.copytree(base, r, symlinks=True)
        if a in ARMS_G: hashes[a] = setup_gnomon(r, a, url, os.path.join(WORK, f"home-{a}"))
        roots[a] = r
    return roots, hashes

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--out", required=True); ap.add_argument("--rounds", type=int, default=20)
    ap.add_argument("--sizes", default="0,2000,5000,20000,50000"); ap.add_argument("--d", type=int, default=0)
    ap.add_argument("--nogit", default="20000")
    a = ap.parse_args()
    become_subreaper(); os.makedirs(WORK, exist_ok=True)
    v = subprocess.run(["gnomon", "--version"], env=env_for(os.path.join(WORK, "home-default")), capture_output=True, text=True).stdout.strip()
    assert v == EXPECT, f"wrong build {v}"
    srv, url = start_model()
    out = open(a.out, "a")
    def emit(r): out.write(json.dumps(r) + "\n"); out.flush()
    meta = {"meta": True, "mode": a.mode, "url": url, "build": v, "affinity": sorted(os.sched_getaffinity(0)), "nice": os.nice(0), "load_threshold": LOAD_THRESHOLD, "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    base0 = os.path.join(WORK, "repo-0-git")
    if not os.path.exists(base0): generate(base0, 0, True)

    if a.mode in ("main", "smoke", "strace", "home"):
        arms = {"main": ["default", "audit-off", "gov-off", "N", "F0"], "smoke": ["default", "audit-off", "gov-off", "N", "F0"],
                "strace": ["default", "audit-off", "gov-off", "N"], "home": ["default"]}[a.mode]
        roots, hashes = build_arms(base0, arms, url, "r0")
        meta["surface_hashes"] = hashes; emit(meta)
        cells = [("S0", 0), ("S0", 250), ("S1", 0), ("S1", 250)] if a.mode != "strace" else [("S0", 0), ("S1", 0)]
        if a.mode == "home": cells = [("S1", 0)]
        bodies = {}
        for scen, d in cells:  # warm-up, discarded: warms the file cache and records F0's bodies
            for arm in arms:
                if arm == "F0": continue
                reset_repo(roots[arm]); rec = []
                trial(srv, arm_cmd(arm, url, scen), roots[arm], env_for(os.path.join(WORK, f"home-{arm}")), scen, 0, rec if arm == "default" else None)
                if arm == "default":
                    bodies[scen] = os.path.join(WORK, f"bodies-{scen}.jsonl"); open(bodies[scen], "w").write("\n".join(rec) + "\n")
        for rnd in range(a.rounds):
            for scen, d in cells:
                order = arms[rnd % len(arms):] + arms[:rnd % len(arms)]
                for arm in order:
                    cwd = roots.get(arm, roots["default"])
                    if arm != "F0": reset_repo(cwd)
                    home = os.path.join(WORK, f"home-{arm}")
                    if a.mode == "home":
                        home = os.path.join(WORK, f"coldhome-{rnd}"); shutil.rmtree(home, ignore_errors=True)
                    st = os.path.join(WORK, f"strace-{arm}-{scen}-{rnd}.txt") if a.mode == "strace" else None
                    r = trial(srv, arm_cmd(arm, url, scen, bodies.get(scen)), cwd, env_for(home), scen, d, strace=st)
                    if arm == "F0":  # F0 replays bodies; the repository and script checks do not apply
                        r["valid"] = r["exit"] == 0 and r["requests"] == len(SCEN[scen]["script"]) + 1; r["problems"] = [] if r["valid"] else ["replay incomplete"]
                    if st: r["spawns"] = classify(st)
                    r.update(round=rnd, scenario=scen, d=d, arm=arm, condition="cold-home" if a.mode == "home" else "cold-process", t_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                    emit(r)
            print(f"round {rnd} done", file=sys.stderr, flush=True)
    elif a.mode == "warm":
        roots, hashes = build_arms(base0, ["default"], url, "r0"); meta["surface_hashes"] = hashes; emit(meta)
        cells = [("S0", 0), ("S1", 0), ("S1", 250)]
        for rnd in range(a.rounds):
            for scen, d in cells:
                root = roots["default"]; reset_repo(root); srv.model.reset(scen, d)
                r0 = resource.getrusage(resource.RUSAGE_CHILDREN); load = os.getloadavg()[0]
                pr = subprocess.run(["node", os.path.join(HERE, "acp_warm.mjs"), "5", SCEN[scen]["prompt"], json.dumps(SRC)], cwd=root,
                                    env=env_for(os.path.join(WORK, "home-default")), capture_output=True, text=True, timeout=300)
                reap_orphans(0.2); log = list(srv.model.log)
                lines = [json.loads(x) for x in pr.stdout.splitlines() if x.strip()]
                for L in lines[1:]:
                    ts, td = int(L["t_send_ns"]) / 1e9, int(L["t_done_ns"]) / 1e9
                    w = [x for x in log if ts <= x["t"] <= td]
                    wall = (td - ts) * 1000
                    problems = []
                    if [x["k"] for x in w] != list(range(len(SCEN[scen]["script"]) + 1)): problems.append(f"request sequence {[x['k'] for x in w]}")
                    if tree_hash_of({k: L["files"][k] for k in SRC}) != expected_hash(scen): problems.append("final repository hash differs")
                    if L.get("error") or L.get("stopReason") != "end_turn": problems.append(f"stop {L.get('stopReason')} {L.get('error')}")
                    emit({"round": rnd, "scenario": scen, "d": d, "arm": "default", "condition": "warm-session" if L["prompt"] > 1 else "warm-session:first-prompt",
                          "prompt": L["prompt"], "wall_ms": round(wall, 2), "harness_wall_ms": round(wall - len(w) * d, 2),
                          "cpu_ms": round(L["cpu_self_ns"] / 1e6 + L["cpu_children_ticks"] * 10, 2), "cpu_self_ms": round(L["cpu_self_ns"] / 1e6, 2), "cpu_children_ms_tick10": L["cpu_children_ticks"] * 10,
                          "first_req_ms": round((w[0]["t"] - ts) * 1000, 2) if w else None, "requests": len(w), "bytes_total": sum(x["bytes"] for x in w),
                          "bytes_per_req": round(sum(x["bytes"] for x in w) / max(1, len(w)), 1), "stream": w[0]["stream"] if w else None,
                          "load1": load, "load_flag": load > LOAD_THRESHOLD, "valid": not problems, "problems": problems, "ready_ms": lines[0].get("ready_ns", 0) / 1e6,
                          "t_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            print(f"warm round {rnd} done", file=sys.stderr, flush=True)
    elif a.mode == "s3":
        sizes = [int(x) for x in a.sizes.split(",")]
        repos = [(n, True) for n in sizes] + [(int(x), False) for x in a.nogit.split(",") if x]
        emit(meta)
        for n, use_git in repos:
            tag = f"repo-{n}-{'git' if use_git else 'nogit'}"; base = os.path.join(WORK, tag)
            if not os.path.exists(base): generate(base, n, use_git)
            roots, hashes = build_arms(base, ["default", "N"], url, tag)
            for arm in ("default", "N"):
                reset_repo(roots[arm]); trial(srv, arm_cmd(arm, url, "S1"), roots[arm], env_for(os.path.join(WORK, f"home-{arm}")), "S1", 0)
            for rnd in range(a.rounds):
                for arm in (["default", "N"] if rnd % 2 == 0 else ["N", "default"]):
                    reset_repo(roots[arm])
                    r = trial(srv, arm_cmd(arm, url, "S1"), roots[arm], env_for(os.path.join(WORK, f"home-{arm}")), "S1", a.d)
                    r.update(round=rnd, scenario="S3", files=n, git=use_git, d=a.d, arm=arm, condition="cold-process", surface_hash=hashes.get(arm),
                             fidelity=(r.get("tree_delta_files") / EDITED_FILES) if r.get("tree_delta_files") is not None else None,
                             t_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                    emit(r)
            print(f"{tag} done", file=sys.stderr, flush=True)

def classify(path):
    """execve lines from strace -f: count successful execs by kind. Inferred method (§5)."""
    kinds = {}
    for line in open(path):
        m = re.match(r'\d+\s+execve\("([^"]+)", \[(.*?)\]', line)
        if not m or not line.rstrip().endswith("= 0"): continue
        prog = os.path.basename(m.group(1)); argv = m.group(2)
        if prog in ("sh", "bash", "dash") and '"true"' in argv: k = "tool:bash(true)"
        elif prog in ("grep", "rg"): k = "tool:search:" + prog
        elif prog == "git": k = "harness:git"
        elif prog.startswith("gnomon-"): k = "harness:" + prog
        elif prog in ("node", "gnomon"): k = "harness:" + prog
        else: k = "other:" + prog
        kinds[k] = kinds.get(k, 0) + 1
    return kinds

if __name__ == "__main__":
    main()
