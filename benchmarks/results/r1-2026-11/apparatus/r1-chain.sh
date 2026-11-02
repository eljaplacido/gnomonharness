#!/usr/bin/env bash
# R1's launch chain, started detached (setsid nohup) so it survives the session.
# Order, all from files the earlier runs write, never from a clock guess:
#   1. LEAN stage 2 ends (" DONE" in lean-2026-11/STATUS-local.txt).
#   2. The build is decided by stage 2's pre-registered rule (lean solves >= base - 2):
#      pass -> wait up to 2 h for PR #80 to be merged, then pin origin/master;
#      fail -> pin origin/master as it is. Written to BUILD.txt.
#   3. P1's four disturbed re-runs finish (" DONE" after the "RERUN" line in
#      peers-2026-11/STATUS-full.txt), or nothing is re-running 30 min after step 1.
#      run_r1.py then takes gpu.lock itself, so nothing can overlap on the GPU.
#   4. Smoke at the pinned build: every arm + NEG on hello-world. Any arm cell not
#      valid, or NEG not flagged misrouted -> SMOKE-FAILED.txt, and R1 does not start.
#   5. The pre-registration is marked final and committed, then the measured run starts.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
RES="$(cd "$BENCH/.." && pwd)"; WT="$(cd "$RES/../.." && pwd)"
LEAN="$RES/lean-2026-11"; P1="$RES/peers-2026-11"
STATUS="$BENCH/STATUS.txt"; REPO=eljaplacido/gnomonharness
say() { echo "$(date -u +%FT%TZ) CHAIN $*" | tee -a "$STATUS"; }

say "waiting for LEAN stage 2 to finish"
until grep -q " DONE$" "$LEAN/STATUS-local.txt" 2>/dev/null; do sleep 120; done
t_stage2=$(date +%s)
base=$(awk '$1=="base"{print $3; exit}' "$LEAN/summary-local.txt")
lean=$(awk '$1=="lean"{print $3; exit}' "$LEAN/summary-local.txt")
if [[ "$base" =~ ^[0-9]+$ && "$lean" =~ ^[0-9]+$ ]] && (( lean >= base - 2 )); then
  verdict=pass
  say "stage 2: lean $lean vs base $base solved -> PASS; waiting up to 2 h for PR #80 to be merged"
  until [ "$(gh pr view 80 -R "$REPO" --json state --jq .state 2>/dev/null)" = "MERGED" ] \
        || (( $(date +%s) - t_stage2 > 7200 )); do sleep 120; done
else
  verdict=fail
  say "stage 2: lean ${lean:-?} vs base ${base:-?} solved -> FAIL (or unreadable): build is master without waiting for #80"
fi
SHA=$(git ls-remote "https://github.com/$REPO.git" refs/heads/master | cut -f1)
pr_state=$(gh pr view 80 -R "$REPO" --json state --jq .state 2>/dev/null)
mc=$(gh pr view 80 -R "$REPO" --json mergeCommit --jq '.mergeCommit.oid // ""' 2>/dev/null)
has80=no
if [ -n "$mc" ]; then
  rel=$(gh api "repos/$REPO/compare/$mc...$SHA" --jq .status 2>/dev/null)
  [[ "$rel" == "identical" || "$rel" == "ahead" ]] && has80=yes
fi
cat > "$BENCH/BUILD.txt" <<EOF
decided_at: $(date -u +%FT%TZ)
stage2_solved: base=${base:-?} lean=${lean:-?} rule="lean >= base - 2" verdict=$verdict
pr80_state: ${pr_state:-unknown} merge_commit: ${mc:-none}
build_sha: $SHA (origin/master at decision time)
build_contains_pr80: $has80
EOF
say "build pinned: $SHA (contains #80: $has80)"

say "waiting for P1's disturbed re-runs to release the GPU"
until awk '/RERUN/{r=1} r && / DONE$/{d=1} END{exit !d}' "$P1/STATUS-full.txt" 2>/dev/null \
      || { ! pgrep -f "[r]erun_disturbed.sh" >/dev/null && ! pgrep -f "[r]un_peers.sh" >/dev/null \
           && (( $(date +%s) - t_stage2 > 1800 )); }; do sleep 120; done
say "GPU queue clear; smoke at the pinned build"

cd "$BENCH"
R1_SHA="$SHA" python3 -I "$HERE/run_r1.py" smoke >>"$BENCH/run-smoke.log" 2>&1
if ! python3 -I "$HERE/collect_r1.py" "$BENCH/runs-smoke" --smoke > "$BENCH/smoke-summary.txt" 2>&1; then
  cp "$BENCH/smoke-summary.txt" "$BENCH/SMOKE-FAILED.txt"
  say "SMOKE FAILED (smoke-summary.txt); R1 not started. Needs a fix logged as an amendment."
  exit 1
fi
say "smoke PASS"

{
  echo
  echo "## Final, before any measured cell ($(date -u +%FT%TZ))"
  echo
  echo "Build under test: \`$SHA\` (origin/master at decision time; contains #80: $has80)."
  echo "Stage 2 verdict that decided it: base=${base:-?} lean=${lean:-?} solved, rule lean >= base - 2 → **$verdict**."
  echo "Smoke at this build, every arm + NEG on hello-world (\`smoke-summary.txt\`):"
  echo
  echo '```'
  cat "$BENCH/smoke-summary.txt"
  echo '```'
  echo
  echo "From here on, changes to this file are timestamped amendments."
} >> "$BENCH/PRE-REGISTRATION.md"
git -C "$WT" add "$BENCH/PRE-REGISTRATION.md" "$BENCH/BUILD.txt" "$BENCH/smoke-summary.txt" >/dev/null 2>&1
git -C "$WT" commit -q -m "bench(r1): pre-registration final — build $SHA, smoke passed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WtxrR5sxfL92MoV63a52wz" \
  -- "$BENCH/PRE-REGISTRATION.md" "$BENCH/BUILD.txt" "$BENCH/smoke-summary.txt" \
  && say "pre-registration final: commit $(git -C "$WT" rev-parse --short HEAD)" \
  || { say "FATAL: could not commit the final pre-registration; not launching"; exit 1; }
git -C "$WT" push -q 2>>"$BENCH/run-smoke.log" && say "pushed" || say "push failed (left for the main session); the local commit stands"

say "launching R1 full"
R1_SHA="$SHA" python3 -I "$HERE/run_r1.py" full >>"$BENCH/run-full.log" 2>&1
python3 -I "$HERE/collect_r1.py" "$BENCH/runs" > "$BENCH/summary.txt" 2>&1
say "DONE"
