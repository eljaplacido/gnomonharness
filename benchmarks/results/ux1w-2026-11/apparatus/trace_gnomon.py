"""Exploratory: which processes does one gnomon turn start on Windows? Not measured."""
import json, os, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import run_ux1w as u
port = 19750
arm = sys.argv[1] if len(sys.argv) > 1 else "gnomon-rel"
out = u.ROOT / "runs" / f"trace-{arm}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
home, proj = out / "home", out / "project"
proj.mkdir(parents=True)
env = u.base_env(home)
subprocess.run([u.GIT, "init", "-q", "."], cwd=proj, env=env, check=True)
(proj / "README.md").write_text("# demo\n")
base = f"http://127.0.0.1:{port}/v1"
a = u.arms(base, port)[arm]
a["setup"](home, proj, env, base)
log = out / "spawns.jsonl"; log.touch()
fake = subprocess.Popen([u.NODE, str(u.HERE / "fake-model.mjs")], env={"PATH": u.clean_path(), "SystemRoot": os.environ["SystemRoot"], "FAKE_PORT": str(port)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
try:
    tenv = {**env, "NODE_OPTIONS": f"--require={u.HERE / 'trace-spawn.cjs'}", "TRACE_SPAWN_LOG": str(log)}
    t = time.time(); r = subprocess.run(a["cmd"], cwd=proj, env=tenv, capture_output=True); w = (time.time() - t) * 1000
finally:
    fake.terminate()
recs = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
print(f"{arm}: rc={r.returncode} wall={w:.0f} ms, {len(recs)} child-process calls")
for x in recs:
    print(f"  +{x['at_ms']:5d} ms {x['fn']:13s} {x.get('dur_ms','?'):>4} ms {'FAILED ' if x.get('failed') else ''}{' '.join(x['argv'])[:100]}")
