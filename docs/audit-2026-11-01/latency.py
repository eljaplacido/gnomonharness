"""One-turn latency, UX1-style: v0.3.2 vs v0.3.3 vs candidate B, interleaved, CPU first."""
import json, os, resource, shutil, statistics as st, subprocess, sys, tempfile, time
from pathlib import Path

L = Path(__file__).resolve().parent
A = L.parent
ARMS = {v: L / f"pfx-{v}" / "bin" / "gnomon" for v in ("0.3.2", "0.3.3", "B")}
N = int(sys.argv[1]) if len(sys.argv) > 1 else 12
PORT = 19731
fake = subprocess.Popen(["node", str(A / "fake-model.mjs")], env={**os.environ, "FAKE_PORT": str(PORT)},
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
rows = {v: [] for v in ARMS}
try:
    for i in range(N):
        order = list(ARMS)[i % 3:] + list(ARMS)[:i % 3]
        for v in order:
            g = str(ARMS[v])
            root = Path(tempfile.mkdtemp(dir=L))
            home = root / "h"; proj = root / "p"; home.mkdir(); proj.mkdir()
            env = {"PATH": f"{Path(g).parent}:{Path(shutil.which('node')).parent}:/usr/local/bin:/usr/bin:/bin", "HOME": str(home),
                   "XDG_DATA_HOME": str(home / "xdg"), "LANG": "C.UTF-8", "GNOMON_NO_UPDATE_CHECK": "1"}
            subprocess.run(["git", "init", "-q"], cwd=proj, env=env, check=True)
            subprocess.run([g, "init"], cwd=proj, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["node", str(A / "patch.js")], cwd=proj, check=True,
                           env={**env, "GNOMON_BENCH_URL": f"http://127.0.0.1:{PORT}/v1/chat/completions",
                                "GNOMON_BENCH_MODEL": "fake-model"})
            help_ = subprocess.run([g, "--help"], env=env, capture_output=True, text=True).stdout
            cmd = [g, "task", "Reply with OK.", "--role", "implementor", "--yes"] + (["--trust"] if "--trust" in help_ else [])
            r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
            t0 = time.perf_counter()
            p = subprocess.run(cmd, cwd=proj, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            wall = time.perf_counter() - t0
            r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
            cpu = (r1.ru_utime - r0.ru_utime) + (r1.ru_stime - r0.ru_stime)
            rows[v].append({"wall_ms": wall * 1000, "cpu_ms": cpu * 1000, "rc": p.returncode})
            shutil.rmtree(root, ignore_errors=True)
finally:
    fake.terminate()
out = {}
for v, rs in rows.items():
    ok = [r for r in rs if r["rc"] == 0]
    out[v] = {"n": len(rs), "ok": len(ok), "cpu_med_ms": round(st.median(r["cpu_ms"] for r in ok), 1) if ok else None,
              "wall_med_ms": round(st.median(r["wall_ms"] for r in ok), 1) if ok else None,
              "cpu_iqr": [round(x, 1) for x in st.quantiles([r["cpu_ms"] for r in ok], n=4)[::2]] if len(ok) > 3 else None}
json.dump({"rows": rows, "summary": out}, open(L / "latency.json", "w"), indent=1)
print(json.dumps(out, indent=1))
print("load:", os.getloadavg())
