#!/bin/sh
# Writes the hardware/platform record every GBS result cites.
set -eu
out="${1:-hardware.json}"
python3 -I - "$out" <<'PY'
import json, os, platform, subprocess, sys
def sh(c):
    try: return subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
    except Exception as e: return f"error: {e}"
cpus = sh("lscpu -e=CPU,CORE,MAXMHZ | tail -n +2")
models = sorted(set(l.split(":",1)[1].strip() for l in sh("lscpu").splitlines() if l.startswith("Model name")))
rec = {
  "platform": f"Linux {platform.machine()}",
  "hardware_class": "n/a: no GBS spec run here defines hardware classes (only GBS-HYBRID does)",
  "cpu_models": models,
  "logical_cores": os.cpu_count(),
  "core_layout": "heterogeneous: 10 x Cortex-X925 (max 3900 MHz) + 10 x Cortex-A725 (max 2808 MHz); lscpu -e in cpu_table",
  "cpu_table": cpus.splitlines(),
  "memory_gib": round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30, 1),
  "gpu": sh("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1") or "n/a",
  "os": sh(". /etc/os-release && echo $PRETTY_NAME"),
  "kernel": platform.release(),
  "node": sh("node --version"),
  "git": sh("git --version"),
  "python": platform.python_version(),
  "sh": os.path.realpath("/bin/sh"),
  "machine": "gx10 (NVIDIA GB10, shared: other benchmarks were running on it during these runs; load is recorded per measurement)",
}
json.dump(rec, open(sys.argv[1], "w"), indent=2); print(json.dumps(rec, indent=2)[:400])
PY
