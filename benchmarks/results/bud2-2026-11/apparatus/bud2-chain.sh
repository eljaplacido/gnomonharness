#!/usr/bin/env bash
# BUD-2 chain, hub lane: smoke both arms on hello-world, commit the final
# pre-registration line, then run the measured A/B (96 cells). Design: ../PRE-REGISTRATION.md.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
R1=/home/eljaplacido/gnomon-wt/peers/benchmarks/results/r1-2026-11/STATUS.txt
STATUS="$BENCH/STATUS.txt"
declare -A SHA=([base]="d59e6c198f91d1469198b0677c008323f82d0345" [budget]="c3bcb997293f5cb8726b367a6716a5fbce32add3")
say() { echo "$(date -u +%FT%TZ) CHAIN $*" | tee -a "$STATUS"; }

# Hub lane (amendment 2026-11-02): no wait for R1; the model is the RTX 5090
# server reached through tunnel-hub.sh (127.0.0.1:18280), metered on 172.17.0.1:18281.
export LANE=hub LISTEN_PORT=18281 UPSTREAM=http://127.0.0.1:18280 COUNTERS_PORT=18299 METER=relay-meter-lane.mjs
curl -s -m 10 "$UPSTREAM/v1/models" | grep -q qwen3.6-35b || { say "FATAL: hub lane not answering at $UPSTREAM"; exit 1; }
say "hub lane up; smoke at base=${SHA[base]:0:9} budget=${SHA[budget]:0:9}"

SMOKE_TASK=hello-world PREFIX=b2s STATUS_SUFFIX=-smoke ATTEMPTS=1 bash "$HERE/run_bud2.sh" >"$BENCH/run-smoke.log" 2>&1
python3 -I - "$BENCH/runs" "${SHA[base]}" "${SHA[budget]}" > "$BENCH/smoke-summary.txt" 2>&1 <<'PY'
import json, sys
from pathlib import Path
runs, sha = Path(sys.argv[1]), {"base": sys.argv[2], "budget": sys.argv[3]}
ok = True
for arm in ("base", "budget"):
    d = runs / f"b2s-k1-{arm}-hello-world"
    res = next(d.glob("*/*/results.json"), None)
    checks = {}
    checks["verdict"] = res is not None and json.loads(res.read_text()).get("is_resolved") is not None
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    req = (t.get("after") or {}).get("chat_requests", (t.get("after") or {}).get("requests", 0)) - \
          (t.get("before") or {}).get("chat_requests", (t.get("before") or {}).get("requests", 0)) if t else 0
    checks["metered"] = req > 0
    logs = res.parent / "agent-logs" if res else d
    commit = (logs / "gnomon-commit.txt").read_text().split("\n")[0].strip() if (logs / "gnomon-commit.txt").exists() else ""
    checks["commit"] = commit == sha[arm]
    cwd = (logs / "gnomon-cwd.txt").read_text(errors="replace") if (logs / "gnomon-cwd.txt").exists() else ""
    full = (logs / "gnomon-full.log").read_text(errors="replace") if (logs / "gnomon-full.log").exists() else ""
    checks["deadline_logged"] = "BUD_DEADLINE_S=" in cwd
    if arm == "budget":
        checks["announced"] = "the model is told how much of it is left" in full
    else:
        checks["no_budget_lines"] = "[budget]" not in full and "the model is told" not in full
    print(arm, "requests", req, json.dumps(checks))
    ok = ok and all(checks.values())
print("SMOKE", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
if [ $? -ne 0 ]; then
  cp "$BENCH/smoke-summary.txt" "$BENCH/SMOKE-FAILED.txt"
  say "SMOKE FAILED (smoke-summary.txt); BUD-2 not started. Needs a fix logged as an amendment."
  exit 1
fi
say "smoke PASS"

printf '\n**Final:** smoke passed (`smoke-summary.txt`); this file is the BUD-2 pre-registration as of %s, before any measured `b2-` cell.\n' "$(date -u +%FT%TZ)" >> "$BENCH/PRE-REGISTRATION.md"
git -C "$WT" add -- "$BENCH/PRE-REGISTRATION.md" "$BENCH/smoke-summary.txt" "$BENCH/STATUS.txt" >/dev/null 2>&1
git -C "$WT" commit -q -m "bench(bud2): smoke passed; pre-registration final before the first measured cell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WtxrR5sxfL92MoV63a52wz" \
  -- "$BENCH/PRE-REGISTRATION.md" "$BENCH/smoke-summary.txt" "$BENCH/STATUS.txt" \
  && say "pre-registration final: commit $(git -C "$WT" rev-parse --short HEAD)" \
  || { say "FATAL: could not commit the final pre-registration; not launching"; exit 1; }
git -C "$WT" push -q 2>>"$BENCH/run-smoke.log" && say "pushed" || say "push failed (left for the main session); the local commit stands"

say "launching BUD-2 full (96 cells)"
bash "$HERE/run_bud2.sh" >"$BENCH/run-full.log" 2>&1
say "DONE"
