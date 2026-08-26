#!/usr/bin/env python3
"""
Extended benchmark: performance, quality, token/context efficiency, determinism.

Four harnesses, one model (qwen2.5:7b-instruct via local Ollama), one machine,
fresh fixture per run, all unattended:

  gnomon    task --yes --json
  opencode  run --auto
  pi        -p --no-session
  omp       -p --no-session --approval-mode yolo   (oh-my-pi, pi lineage)

Quality is scored per criterion rather than pass/fail, because "wrong answer"
and "right answer with a fabricated extra file" are different failures and a
binary check hides that.
"""
import json, os, re, shutil, sqlite3, statistics as st, subprocess, sys, time
from pathlib import Path

ROOT = Path("/tmp/claude-1000/-home-eljaplacido-Desktop-gnomon/ac2c4057-bbed-4190-9a9f-b089f8918684/scratchpad/bench")
# Fixtures live OUTSIDE the benchmark directory on purpose. With work/ nested
# under bench/, a harness that searches upward finds bench.py — which contains
# the fixture files as string literals — and answers from the benchmark's own
# source. opencode did exactly that: it reported TIMEOUT_SECONDS "in
# bench/bench.py", which is neither the fixture nor an answer.
WORK = Path("/tmp/claude-1000/-home-eljaplacido-Desktop-gnomon/ac2c4057-bbed-4190-9a9f-b089f8918684/fixtures")
PROVIDER = os.environ.get("BENCH_PROVIDER", "ollama")   # ollama | openrouter
IS_OR = PROVIDER == "openrouter"
PICONF = (ROOT/"or"/"piconf") if IS_OR else (ROOT/"piconf")
OMP_OVERLAY = (ROOT/"or"/"omp-openrouter.yml") if IS_OR else (ROOT/"omp-ollama.yml")
GNOMON = "/home/eljaplacido/Desktop/gnomon/packages/gnomon-cli/gnomon.js"
OPENCODE = "/home/eljaplacido/.opencode/bin/opencode"
PI = "/home/eljaplacido/.local/bin/pi"
OMP = "/home/eljaplacido/.local/bin/omp"
PIRS = os.path.expanduser("~/pi-builds/pi_agent_rust/target/release/pi")
OC_DB = (ROOT/"or"/"occonf"/"bench.db") if IS_OR else (ROOT/"occonf"/"bench.db")
OC_CONF = (ROOT/"or"/"occonf"/"opencode.json") if IS_OR else (ROOT/"occonf"/"opencode.json")
MODEL = os.environ.get("BENCH_MODEL", "qwen2.5:7b-instruct")
TAG = os.environ.get("BENCH_TAG", MODEL.replace(":", "_").replace(".", "_"))
TIMEOUT = int(os.environ.get("BENCH_TIMEOUT", "240"))
TRIALS = int(os.environ.get("TRIALS", "3"))
DET_REPEATS = int(os.environ.get("DET_REPEATS", "5"))

FIXTURE = {
    "src/db/conn.py": "TIMEOUT_SECONDS = 30\n\ndef get_conn():\n    return _Conn(TIMEOUT_SECONDS)\n\nclass _Conn:\n    def __init__(self, t):\n        self.t = t\n",
    "src/util/retry.py": "TIMEOUT_SECONDS = 5\n\ndef retry(fn, attempts=3):\n    return fn()\n",
    "src/calc.py": "def add(a, b):\n    return a + b\n\ndef divide(a, b):\n    if b == 0:\n        raise ZeroDivisionError('b must not be zero')\n    return a / b\n",
    "README.md": "# fixture app\n",
}
SETUP_MS = {}

def make_fixture(d, harness):
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    for rel, body in FIXTURE.items():
        p = d / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    subprocess.run(["git", "init", "-q"], cwd=d, capture_output=True)
    if harness == "gnomon":
        t0 = time.time()
        subprocess.run(["node", GNOMON, "init"], cwd=d, capture_output=True, timeout=120)
        SETUP_MS.setdefault("gnomon", []).append(int((time.time() - t0) * 1000))
        if IS_OR:
            c = d / ".gnomon/config.toml"
            t = c.read_text()
            t = t.replace("[endpoints.local]",
                '[endpoints.openrouter]\n'
                'url = "https://openrouter.ai/api/v1/chat/completions"\n'
                'kind = "openai"\n'
                'api_key_env = "OPENROUTER_API_KEY"\n\n'
                "[endpoints.local]", 1)
            c.write_text(t)
        r = d / ".gnomon/roles.toml"
        if r.exists():
            t = re.sub(r'^model = ".*"$', f'model = "{MODEL}"', r.read_text(), flags=re.M)
            if IS_OR:
                t = re.sub(r'^endpoint = ".*"$', 'endpoint = "openrouter"', t, flags=re.M)
            r.write_text(t)

# --------------------------------------------------------------- quality
def q_search(out, d):
    o = (out or "").lower()
    return {
        "names conn.py": "conn.py" in o,
        "names retry.py": "retry.py" in o,
        "no fabricated file": not re.search(r"\b(config|settings|main|app)\.(py|toml|rs)\b", o),
    }

def q_read(out, d):
    o = (out or "").lower()
    return {
        "names ZeroDivisionError": "zerodivisionerror" in o.replace(" ", ""),
        "says it raises": ("rais" in o or "throw" in o or "exception" in o),
        "concise (<60 words)": 0 < len((out or "").split()) < 60,
    }

def q_arith(out, d):
    flat = (out or "").replace(",", "").replace(" ", "")
    exact = ("3395.9012" in flat) or ("3395.90" in flat) or ("3395.9" in flat)
    other = bool(re.search(r"\b3[0-9]{3}\.[0-9]{2}", flat)) and not exact
    return {
        "exact total 3395.90": exact,
        "no wrong total stated": not other,
    }

def q_edit(out, d):
    p = d / "src/calc.py"
    src = p.read_text() if p.exists() else ""
    defined = bool(re.search(r"def\s+subtract\s*\(", src))
    works = False
    if defined:
        r = subprocess.run([sys.executable, "-c",
            "import sys;sys.path.insert(0,'src');import calc;assert calc.subtract(10,3)==7"],
            cwd=d, capture_output=True)
        works = r.returncode == 0
    return {
        "subtract defined": defined,
        "subtract correct": works,
        "kept add and divide": ("def add" in src) and ("def divide" in src),
    }

def q_multi(out, d):
    o = (out or "").lower()
    return {
        "names conn.py": "conn.py" in o,
        "value 30": "30" in (out or ""),
        "not confused by 5": not re.search(r"larger.{0,30}\b5\b", o),
    }

TASKS = [
    ("search", "Find every file in this repository that defines TIMEOUT_SECONDS. List the file paths.", q_search),
    ("read",   "Read src/calc.py. What does divide(a, b) do when b is 0? Answer in one sentence.", q_read),
    ("arith",  "An invoice has 137 line items at 19.99 each, plus 24% VAT. Give the exact total.", q_arith),
    ("edit",   "Add a function subtract(a, b) to src/calc.py that returns a - b. Keep the existing functions.", q_edit),
    ("multi",  "Two files define TIMEOUT_SECONDS. Report which file has the LARGER value, and what that value is.", q_multi),
]
BASELINE = "Reply with exactly one word: ready"

# --------------------------------------------------------------- runners
def reap():
    """Kill harness processes left behind by a finished run.

    Not just opencode. Every harness here can survive its own subprocess.run,
    and leftovers do not merely waste memory: with a handful alive, runs that
    take 2s standalone hit a 300s timeout. Two separate passes of this
    benchmark were invalidated that way before the cause was found, so the
    reap is unconditional and covers all of them.
    """
    pats = ["opencode/bin", "local/bin/pi", "local/bin/omp", "pi_agent_rust"]
    for pat in pats:
        try:
            out = subprocess.run(["pgrep", "-f", pat], capture_output=True,
                                 text=True, timeout=10).stdout
        except Exception:
            continue
        for pid in [x for x in out.split() if x.isdigit()]:
            if int(pid) == os.getpid():
                continue
            try:
                cl = open(f"/proc/{pid}/cmdline", "rb").read().decode("utf-8", "ignore")
            except Exception:
                continue
            # never touch this session's own shells
            if "shell-snapshots" in cl or "claude" in cl or "bench4" in cl:
                continue
            try:
                os.kill(int(pid), 9)
            except Exception:
                pass
    time.sleep(1.5)


def run_gnomon(prompt, d):
    t0 = time.time()
    r = subprocess.run(["node", GNOMON, "task", prompt, "--yes", "--json"],
                       cwd=d, capture_output=True, text=True, timeout=TIMEOUT)
    ms = int((time.time()-t0)*1000)
    out, ti, to, calls = r.stdout, None, None, None
    try:
        j = json.loads(r.stdout[r.stdout.index("{"):])
        out = j.get("output", "")
        v = j.get("volatile", {})
        ti, to, calls = v.get("tokens_in"), v.get("tokens_out"), j.get("tool_steps")
    except Exception: pass
    return ms, out, ti, to, calls

def _oc_ids():
    try:
        c = sqlite3.connect(f"file:{OC_DB}?mode=ro", uri=True)
        ids = {r[0] for r in c.execute("select id from session order by time_created desc limit 5")}
        c.close(); return ids
    except Exception: return set()

def run_opencode(prompt, d):
    before = _oc_ids()
    t0 = time.time()
    env = dict(os.environ, OPENCODE_CONFIG=str(OC_CONF), OPENCODE_DB=str(OC_DB))
    r = subprocess.run([OPENCODE, "run", "--auto", "--model", f"{PROVIDER}/{MODEL}", prompt],
                       cwd=d, capture_output=True, text=True, timeout=TIMEOUT, env=env)
    ms = int((time.time()-t0)*1000)
    out = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", r.stdout + "\n" + r.stderr)
    ti = to = calls = None
    try:
        c = sqlite3.connect(f"file:{OC_DB}?mode=ro", uri=True)
        new = [x[0] for x in c.execute("select id from session order by time_created desc limit 5")
               if x[0] not in before]
        if new:
            q = c.execute("select sum(coalesce(json_extract(data,'$.tokens.input'),0)"
                          "  + coalesce(json_extract(data,'$.tokens.cache.read'),0)"
                          "  + coalesce(json_extract(data,'$.tokens.cache.write'),0)),"
                          " sum(json_extract(data,'$.tokens.output')),"
                          " sum(case when json_extract(data,'$.type')='tool' then 1 else 0 end)"
                          " from part where session_id=?", (new[0],)).fetchone()
            ti, to, calls = q
        c.close()
    except Exception: pass
    reap()
    return ms, out, ti, to, calls

def _pi_family(binary, prompt, d, extra):
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(PICONF))
    cmd = [binary, "-p", "--no-session", "--mode", "json"] + extra + [prompt]
    t0 = time.time()
    r = subprocess.run(cmd, cwd=d, capture_output=True, text=True, timeout=TIMEOUT, env=env)
    ms = int((time.time()-t0)*1000)
    text, ti, to, calls = "", 0, 0, 0
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"): continue
        try: ev = json.loads(line)
        except Exception: continue
        if ev.get("type") == "turn_end":
            m = ev.get("message", {}); u = m.get("usage", {}) or {}
            # cacheRead/cacheWrite are context the model actually processed.
            # Counting only `input` is correct on Ollama (no caching) but
            # collapses to the uncached delta on OpenRouter -- omp reported a
            # 0-token baseline against a 15k prompt that way, and any frontier
            # cost table built on it would measure cache hit-rate rather than
            # how much context the harness sends.
            ti += ((u.get("input", 0) or 0) + (u.get("cacheRead", 0) or 0)
                   + (u.get("cacheWrite", 0) or 0))
            to += u.get("output", 0) or 0
            calls += len(ev.get("toolResults") or [])
            for c in m.get("content", []) or []:
                if c.get("type") == "text": text += c.get("text", "")
    return ms, (text or r.stdout), (ti or None), (to or None), calls

def run_pi(prompt, d):
    return _pi_family(PI, prompt, d, ["--provider", PROVIDER, "--model", MODEL])

def run_omp(prompt, d):
    return _pi_family(OMP, prompt, d,
                      ["--config", str(OMP_OVERLAY), "--approval-mode", "yolo",
                       "--model", f"{PROVIDER}/{MODEL}"])


def run_pirs(prompt, d):
    """pi-rs — the Rust port of pi, same lineage, different runtime.

    Its --mode json emits a different shape from the TypeScript pi: usage rides
    on assistant messages inside a final object rather than on line-delimited
    turn_end events, so the walk is over every JSON value found rather than a
    single event type.
    """
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(PICONF))
    cmd = [PIRS, "-p", "--no-session", "--mode", "json",
           "--provider", PROVIDER, "--model", MODEL, prompt]
    t0 = time.time()
    r = subprocess.run(cmd, cwd=d, capture_output=True, text=True, timeout=TIMEOUT, env=env)
    ms = int((time.time() - t0) * 1000)

    text, ti, to, calls = "", 0, 0, 0
    seen = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if line.startswith("{") or line.startswith("["):
            try:
                seen.append(json.loads(line))
            except Exception:
                pass

    def walk(node):
        nonlocal text, ti, to, calls
        if isinstance(node, list):
            for x in node:
                walk(x)
            return
        if not isinstance(node, dict):
            return
        u = node.get("usage")
        if isinstance(u, dict):
            ti += ((u.get("input", 0) or 0) + (u.get("cacheRead", 0) or 0)
                   + (u.get("cacheWrite", 0) or 0))
            to += u.get("output", 0) or 0
        if node.get("role") == "assistant":
            for c in node.get("content", []) or []:
                if isinstance(c, dict) and c.get("type") == "text":
                    text += c.get("text", "")
        if node.get("role") == "tool" or node.get("type") == "tool_result":
            calls += 1
        for v in node.values():
            if isinstance(v, (dict, list)):
                walk(v)

    for obj in seen:
        walk(obj)
    return ms, (text or r.stdout), (ti or None), (to or None), calls

HARNESSES = [("gnomon", run_gnomon), ("opencode", run_opencode),
             ("pi", run_pi), ("omp", run_omp), ("pi-rs", run_pirs)]

# --------------------------------------------------------------- main
def one(hname, runner, prompt, scorer, tag):
    d = WORK / f"{hname}-{tag}"
    make_fixture(d, hname)
    rec = {"harness": hname, "tag": tag}
    try:
        ms, out, ti, to, calls = runner(prompt, d)
        crit = scorer(out or "", d) if scorer else {}
        rec.update(ms=ms, tokens_in=ti, tokens_out=to, tool_calls=calls,
                   out=(out or "")[:500], criteria=crit,
                   score=sum(1 for v in crit.values() if v), max_score=len(crit),
                   ok=(all(crit.values()) if crit else None))
    except subprocess.TimeoutExpired:
        rec.update(ms=TIMEOUT*1000, tokens_in=None, tokens_out=None, tool_calls=None,
                   out="TIMEOUT", criteria={}, score=0, max_score=0, ok=False)
    except Exception as e:
        rec.update(ms=None, tokens_in=None, tokens_out=None, tool_calls=None,
                   out=f"ERROR {e}", criteria={}, score=0, max_score=0, ok=False)
    reap()
    shutil.rmtree(d, ignore_errors=True)
    time.sleep(2)
    return rec

def main():
    runs, base, det = [], [], []
    # 1. baseline overhead — what the harness costs before any work
    for hname, runner in HARNESSES:
        r = one(hname, runner, BASELINE, None, "baseline")
        r["task"] = "baseline"; base.append(r)
        print(f"[base] {hname:9s} {str(r['ms']):>7s}ms in={r['tokens_in']}", flush=True)
    # 2. quality + performance
    for t in range(1, TRIALS+1):
        for tname, prompt, scorer in TASKS:
            for hname, runner in HARNESSES:
                r = one(hname, runner, prompt, scorer, f"{tname}-{t}")
                r["task"], r["trial"] = tname, t
                runs.append(r)
                print(f"[{t}] {tname:8s} {hname:9s} {r['score']}/{r['max_score']} "
                      f"{str(r['ms']):>7s}ms in={r['tokens_in']} calls={r['tool_calls']}", flush=True)
    # 3. determinism — same prompt repeated, how much does the answer move
    for tname, prompt, scorer in [TASKS[0], TASKS[2]]:
        for hname, runner in HARNESSES:
            for i in range(DET_REPEATS):
                r = one(hname, runner, prompt, scorer, f"det-{tname}-{i}")
                r["task"], r["det"] = tname, True
                det.append(r)
            print(f"[det] {tname:8s} {hname:9s} done", flush=True)
    (ROOT/f"results_{TAG}.json").write_text(json.dumps(
        {"runs": runs, "baseline": base, "determinism": det, "setup_ms": SETUP_MS}, indent=1))
    print(f"\nwrote results_{TAG}.json")

if __name__ == "__main__":
    main()
