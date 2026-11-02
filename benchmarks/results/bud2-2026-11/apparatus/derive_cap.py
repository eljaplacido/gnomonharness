"""BUD-2's cap, derived before any BUD-2 trial by a rule fixed in the pre-registration:
the 70th percentile of BUD's base-arm valid cells' agent durations (tb agent phase,
setup included, as tb's --global-agent-timeout-sec counts it), rounded UP to the
nearest 30 s, floor 240 s. Also prints the share of those base cells that would have
reached that cap."""
import json, math, sys
from pathlib import Path
cells = json.load(open(sys.argv[1]))["cells"]
base = sorted(c["agent_s"] for c in cells if c["arm"] == "base" and c.get("state") == "valid" and c.get("agent_s"))
n = len(base)
# Nearest-rank 70th percentile (no interpolation): the smallest value with >= 70% at or below it.
rank = math.ceil(0.70 * n)
p70 = base[rank - 1]
cap = max(240, math.ceil(p70 / 30) * 30)
over = sum(1 for s in base if s >= cap)
print(json.dumps({"n_base_valid": n, "p70_nearest_rank_s": round(p70, 1), "cap_s": cap,
                  "base_cells_at_or_over_cap": over, "share": round(over / n, 3),
                  "durations_s": [round(s) for s in base]}, indent=1))
