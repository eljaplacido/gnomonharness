#!/usr/bin/env python3
"""Run one arm of the DFlash on/off wall-clock experiment.

Usage: runner.py <arm-label>
Env (all optional):
  GNOMON_JS          path to packages/gnomon-cli/gnomon.js (default: repo-relative)
  BENCH_MODEL        the model tag the endpoint serves (default: a placeholder)
  BENCH_ENDPOINT_URL OpenAI-shaped chat-completions URL (default: :18080 llama-server)
  TRIALS             trials per task (default 4)
  CAP                seconds per gnomon run before it is killed (default 240)
  TASK               run a single named task (for a dry run)

For each task x trial: a fresh workspace gets the task's fixture and a freshly
built gnomon surface (a role pointed at the endpoint, GREEDY temp 0 so the two
arms are output-exact). It runs `gnomon task <prompt> --role implement --yes
--json` under a wall-clock cap, records bucket/wall/tokens, then runs the task's
verify. One JSONL line is flushed per trial so a crash never loses data.
"""
import json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from tasks import TASKS

HERE = Path(__file__).parent
REPO = HERE.parents[2]  # benchmarks/results/dflash-2026-08 -> repo root
GN = os.environ.get("GNOMON_JS", str(REPO / "packages" / "gnomon-cli" / "gnomon.js"))
MODEL = os.environ.get("BENCH_MODEL", "local-model")
ENDPOINT_URL = os.environ.get("BENCH_ENDPOINT_URL", "http://127.0.0.1:18080/v1/chat/completions")
ARM = sys.argv[1]
N = int(os.environ.get("TRIALS", "4"))
CAP = int(os.environ.get("CAP", "240"))
ONLY = os.environ.get("TASK")
OUT = HERE / "results" / f"{ARM}.jsonl"
OUT.parent.mkdir(exist_ok=True)


def build_surface(dst_gnomon: Path):
    """gnomon init into a temp dir, then point the implement role at the endpoint,
    greedy. Kept out of the committed tree because the model tag is machine-local."""
    tmp = Path(tempfile.mkdtemp(prefix="dfb-surface-"))
    subprocess.run(["node", GN, "init"], cwd=tmp, capture_output=True)
    cfg = (tmp / ".gnomon" / "config.toml")
    c = cfg.read_text()
    if "[endpoints.bench]" not in c:
        c = c.replace("[endpoints.local]",
                      f'[endpoints.bench]\nurl = "{ENDPOINT_URL}"\nkind = "openai"\n\n[endpoints.local]', 1)
    cfg.write_text(c)
    roles = tmp / ".gnomon" / "roles.toml"
    r = roles.read_text()
    lines = r.split("\n"); out = []; i = 0; n = len(lines)
    while i < n:
        out.append(lines[i])
        if lines[i].strip() == "[roles.implement]":
            i += 1; block = []
            while i < n and not lines[i].strip().startswith("["):
                block.append(lines[i]); i += 1
            kv = {"endpoint": f'"bench"', "temperature": "0", "top_p": "1",
                  "model": f'"{MODEL}"', "max_steps": "40", "max_steps_total": "80"}
            block = [b for b in block if not any(b.strip().startswith(k + " ") or b.strip().startswith(k + "=") for k in kv)]
            for k, v in kv.items():
                block.append(f"{k} = {v}")
            out.extend(block); continue
        i += 1
    roles.write_text("\n".join(out))
    shutil.move(str(tmp / ".gnomon"), str(dst_gnomon))
    shutil.rmtree(tmp, ignore_errors=True)


def extract_json(text):
    idx = text.find('"surface_hash"')
    if idx < 0:
        return None
    start = text.rfind("{", 0, idx)
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except Exception:
                    return None
    return None


def run_trial(task, trial):
    ws = Path(tempfile.mkdtemp(prefix="dfb-"))
    try:
        for rel, content in task["files"].items():
            p = ws / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        build_surface(ws / ".gnomon")
        t0 = time.time()
        status, out, err = "ran", "", ""
        try:
            proc = subprocess.run(
                ["node", GN, "task", task["prompt"], "--role", "implement", "--yes", "--json"],
                cwd=ws, capture_output=True, text=True, timeout=CAP)
            out, err = proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as e:
            status = "timeout"
            out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        wall = time.time() - t0
        j = extract_json(out) or extract_json(out + err)
        bucket = j.get("bucket") if j else ("timeout" if status == "timeout" else "crash")
        vol = (j or {}).get("volatile", {}) or {}
        dur_ms, tok_out, tok_in = vol.get("duration_ms"), vol.get("tokens_out"), vol.get("tokens_in")
        steps = (j or {}).get("tool_steps")
        passed = False
        if status != "timeout":
            try:
                v = subprocess.run(task["verify"], cwd=ws, shell=True, capture_output=True, timeout=45)
                passed = v.returncode == 0
            except Exception:
                passed = False
        return dict(arm=ARM, task=task["name"], trial=trial, status=status, bucket=bucket,
                    passed=passed, wall_s=round(wall, 2), dur_ms=dur_ms,
                    tokens_out=tok_out, tokens_in=tok_in, tool_steps=steps,
                    tok_s=(round(tok_out / (dur_ms / 1000), 1) if tok_out and dur_ms else None))
    finally:
        shutil.rmtree(ws, ignore_errors=True)


def main():
    tasks = [t for t in TASKS if (not ONLY or t["name"] == ONLY)]
    with OUT.open("a") as f:
        for task in tasks:
            for trial in range(N):
                rec = run_trial(task, trial)
                f.write(json.dumps(rec) + "\n")
                f.flush()
                print(f"[{ARM}] {task['name']} #{trial}: {rec['bucket']} pass={rec['passed']} "
                      f"wall={rec['wall_s']}s tok/s={rec['tok_s']} steps={rec['tool_steps']}", flush=True)


if __name__ == "__main__":
    main()
