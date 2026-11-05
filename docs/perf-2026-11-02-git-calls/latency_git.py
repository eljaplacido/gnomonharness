"""One-turn latency, UX1-style: master vs this branch, interleaved, CPU first.
Two conditions: a repo with no commits (UX1W) and a repo with one commit."""
import json, os, resource, shutil, statistics as st, subprocess, sys, tempfile, time
from pathlib import Path

L = Path(__file__).resolve().parent
ARMS = {v: L / f"pfx-{v}" / "bin" / "gnomon" for v in ("master", "gitfix")}
N = int(sys.argv[1]) if len(sys.argv) > 1 else 20
COUNT = len(sys.argv) > 2 and sys.argv[2] == "count"
PORT = 19744
fake = subprocess.Popen(["node", str(L / "fake-model.mjs")], env={**os.environ, "FAKE_PORT": str(PORT)},
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
rows = {(v, c): [] for v in ARMS for c in ("nocommit", "commit")}
loads = []
try:
    for i in range(N):
        for cond in ("nocommit", "commit"):
            order = list(ARMS) if (i + (cond == "commit")) % 2 == 0 else list(ARMS)[::-1]
            for v in order:
                g = str(ARMS[v])
                root = Path(tempfile.mkdtemp(dir=L))
                home = root / "h"; proj = root / "p"; home.mkdir(); proj.mkdir()
                path = f"{Path(g).parent}:{Path(shutil.which('node')).parent}:/usr/local/bin:/usr/bin:/bin"
                log = root / "git.log"
                if COUNT:
                    path = f"{L / 'gitshim'}:{path}"
                env = {"PATH": path, "HOME": str(home), "XDG_DATA_HOME": str(home / "xdg"), "LANG": "C.UTF-8",
                       "GNOMON_NO_UPDATE_CHECK": "1", "GITCOUNT_LOG": str(log),
                       "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
                subprocess.run(["/usr/bin/git", "init", "-q"], cwd=proj, env=env, check=True)
                subprocess.run([g, "init"], cwd=proj, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(["node", str(L / "patch.js")], cwd=proj, check=True,
                               env={**env, "GNOMON_BENCH_URL": f"http://127.0.0.1:{PORT}/v1/chat/completions",
                                    "GNOMON_BENCH_MODEL": "fake-model"})
                if cond == "commit":
                    subprocess.run(["/usr/bin/git", "add", "-A"], cwd=proj, env=env, check=True)
                    subprocess.run(["/usr/bin/git", "commit", "-qm", "init"], cwd=proj, env=env, check=True)
                if log.exists(): log.unlink()
                cmd = [g, "task", "Reply with OK.", "--role", "implementor", "--yes", "--trust"]
                r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
                t0 = time.perf_counter()
                p = subprocess.run(cmd, cwd=proj, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                wall = time.perf_counter() - t0
                r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
                cpu = (r1.ru_utime - r0.ru_utime) + (r1.ru_stime - r0.ru_stime)
                gits = len(log.read_text().splitlines()) if log.exists() else None
                rows[(v, cond)].append({"wall_ms": wall * 1000, "cpu_ms": cpu * 1000, "rc": p.returncode, "git_calls": gits})
                loads.append(os.getloadavg()[0])
                shutil.rmtree(root, ignore_errors=True)
finally:
    fake.terminate()

def paired(cond, key):
    a = [r[key] for r in rows[("master", cond)]]; b = [r[key] for r in rows[("gitfix", cond)]]
    d = sorted(y - x for x, y in zip(a, b))
    fewer = sum(1 for x in d if x < 0)
    return {"median_diff_ms": round(st.median(d), 1), "gitfix_lower_in": f"{fewer}/{len(d)}"}

out = {"n": N, "load_1m": [round(min(loads), 1), round(st.median(loads), 1), round(max(loads), 1)]}
for (v, c), rs in rows.items():
    ok = [r for r in rs if r["rc"] == 0]
    out[f"{v}/{c}"] = {"ok": f"{len(ok)}/{len(rs)}", "cpu_med_ms": round(st.median(r["cpu_ms"] for r in ok), 1),
                       "wall_med_ms": round(st.median(r["wall_ms"] for r in ok), 1),
                       "git_calls": sorted({r["git_calls"] for r in rs})}
for c in ("nocommit", "commit"):
    out[f"paired/{c}/cpu"] = paired(c, "cpu_ms"); out[f"paired/{c}/wall"] = paired(c, "wall_ms")
name = "latency-git-count.json" if COUNT else f"latency-git-n{N}.json"
json.dump({"rows": {f"{v}/{c}": rs for (v, c), rs in rows.items()}, "summary": out}, open(L / name, "w"), indent=1)
print(json.dumps(out, indent=1))
