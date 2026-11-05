#!/usr/bin/env python3
"""Per-call overhead of exec = "os": the UX1b shape (`cat` of one file), as PR #74 measured it.

usage: overhead_os.py <gnomon-exec> <out.jsonl> [--rounds 300]

Five arms, interleaved in a fresh random order every round, `--rounds` rounds:
  off               /bin/sh -c 'cat f'                                 (bash under exec = "off")
  os-net-on         gnomon-exec sandbox ... --network on  -- sh -c ...  (Landlock)
  os-net-off        ... --network off                                  (Landlock + seccomp + supervisor)
  os-scoped-net-on  ... --network on  --reads scoped --read <node prefix> --read <gnomon-exec dir>
  os-scoped-net-off ... --network off --reads scoped (same reads)
Each run is timed from spawn to exit (wall clock, perf_counter). The 1-minute load average is
recorded on every row. Scratch: a temp dir this script creates and removes. HOME is the caller's
(the scoped arms resolve their toolchain defaults from it, as gnomon would); nothing reads it.
"""
import json, os, random, shutil, statistics, subprocess, sys, tempfile, time

EXE, OUTF = sys.argv[1], sys.argv[2]
ROUNDS = int(sys.argv[sys.argv.index("--rounds") + 1]) if "--rounds" in sys.argv else 300
d = tempfile.mkdtemp(prefix="gbs-ossb-overhead-")
root, tmp = os.path.join(d, "root"), os.path.join(d, "tmp")
os.makedirs(root); os.makedirs(tmp)
with open(os.path.join(root, "f"), "w") as f:
    f.write("x" * 4096)
node_prefix = os.path.dirname(os.path.dirname(os.path.realpath(shutil.which("node") or "/usr/bin/node")))
reads = ["--read", node_prefix, "--read", os.path.dirname(os.path.realpath(EXE))]
base = [EXE, "sandbox", "--root", root, "--write", tmp]
CMD = ["/bin/sh", "-c", "cat f"]
ARMS = {
    "off": CMD,
    "os-net-on": base + ["--network", "on", "--"] + CMD,
    "os-net-off": base + ["--network", "off", "--"] + CMD,
    "os-scoped-net-on": base + ["--network", "on", "--reads", "scoped"] + reads + ["--"] + CMD,
    "os-scoped-net-off": base + ["--network", "off", "--reads", "scoped"] + reads + ["--"] + CMD,
}
for name, argv in ARMS.items():  # every arm must run and print the file before timing starts
    r = subprocess.run(argv, cwd=root, capture_output=True)
    assert r.returncode == 0 and len(r.stdout) == 4096, (name, r)
rows = []
for k in range(ROUNDS):
    order = list(ARMS)
    random.shuffle(order)
    for name in order:
        t0 = time.perf_counter()
        r = subprocess.run(ARMS[name], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ms = (time.perf_counter() - t0) * 1000
        rows.append({"round": k, "arm": name, "ms": round(ms, 4), "exit": r.returncode,
                     "load1": float(open("/proc/loadavg").read().split()[0])})
shutil.rmtree(d)
with open(OUTF, "w") as f:
    f.write(json.dumps({"_meta": True, "exe": EXE, "rounds": ROUNDS, "cpus": os.cpu_count(), "uname": os.uname().release,
                        "probe": json.loads(subprocess.run([EXE, "sandbox-probe"], capture_output=True, text=True).stdout).get("landlock_abi")}) + "\n")
    for r in rows:
        f.write(json.dumps(r) + "\n")
off = statistics.median(r["ms"] for r in rows if r["arm"] == "off")
for name in ARMS:
    xs = sorted(r["ms"] for r in rows if r["arm"] == name)
    bad = sum(1 for r in rows if r["arm"] == name and r["exit"] != 0)
    p90 = xs[int(0.9 * (len(xs) - 1))]
    print("%-18s median %.2f ms  p90 %.2f ms  vs off %+.2f ms  (n=%d, nonzero exits %d)" % (
        name, statistics.median(xs), p90, statistics.median(xs) - off, len(xs), bad))
loads = [r["load1"] for r in rows]
print("load1 during the run: min %.2f median %.2f max %.2f on %d CPUs" % (min(loads), statistics.median(loads), max(loads), os.cpu_count()))
