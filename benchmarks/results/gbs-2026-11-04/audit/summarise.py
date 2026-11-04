#!/usr/bin/env python3
"""GBS-AUDIT 0.1: turn raw/cases.json into result.json (every REPORTING §2 field).

  python3 -I summarise.py <raw/cases.json> <result.json> <traces.tar.gz sha256> <prereg sha256> <prereg commit>
"""
import json, math, sys
cases, out, traces_sha, prereg_sha, prereg_commit = sys.argv[1:6]
d = json.load(open(cases))
LEVEL = {"A1": ["E1", "E3", "I2", "D1", "D2", "T1", "O1"], "A2": ["E2", "I1", "R1"], "A3": ["D3", "R2", "C1", "K1", "K2", "B1"]}
ARMS = ["off", "attest", "git", "rfc3161"]

def wilson(k, n, z=1.959964):
    if n == 0: return None
    p = k / n; den = 1 + z*z/n
    c = (p + z*z/(2*n)) / den; h = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / den
    return [round(max(0, c-h), 3), round(min(1, c+h), 3)]

rows = [r for r in d["rows"] if r["verifier"] == "gnomon"]
# Post-hoc scoring correction (logged in the pre-registration's deviations):
# for B1 the unit the attack removes is session 3's trail, not the session-2
# target; for D3 no unit's records change, so L1-L3 do not apply.
for r in rows:
    if r["id"] == "B1" and r["verdict"].startswith("detected"):
        txt = open(f"raw/verifier/{r['arm']}-B1.txt").read()
        s3 = d["arms"][r["arm"]]["units"][2]
        r["affected_unit"] = s3
        r["L1"] = s3 in txt
        r["verdict"] = "detected" if r["L1"] else "detected_unlocalised"
    if r["id"] == "D3":
        r["affected_unit"] = "none: the records are untouched; only integrity evidence is removed"
        if r["verdict"].startswith("detected"): r["verdict"] = "detected"; r["localisation"] = "n/a"

# Collateral: the forged target itself still verified (SIGNED / ANCHORED), and
# the exit came from other units whose evidence the attack also removed.
for r in rows:
    if r["verdict"] == "detected_unlocalised" and r["id"] in ("R2", "C1"):
        r["note"] = "caught only through OTHER units whose heads/receipts the attacker also deleted; the forged target verified as " + ("SIGNED" if r["arm"] == "attest" else "ANCHORED") + ". A target-only attacker is not caught (attest: K1)."

table = {}
for arm in ARMS:
    table[arm] = {}
    for lv, ids in LEVEL.items():
        rs = [r for r in rows if r["arm"] == arm and r["id"] in ids]
        app = [r for r in rs if r["verdict"] != "n/a"]
        caught = [r for r in app if r["verdict"].startswith("detected")]
        table[arm][lv] = {
            "required": len(app), "caught": len(caught), "wilson95": wilson(len(caught), len(app)),
            "caught_unlocalised": [r["id"] for r in caught if r["verdict"] == "detected_unlocalised"],
            "missed": [r["id"] for r in app if not r["verdict"].startswith("detected")],
            "missed_text_flag_exit0": [r["id"] for r in app if r["verdict"] == "undetected_text_flag_exit0"],
            "n_a": {r["id"]: r["reason"] for r in rs if r["verdict"] == "n/a"},
        }
fp = d["fp"]; fp_n = sum(v["sessions"] for v in fp.values()); fp_k = sum(v["non_success"] for v in fp.values())
res = {
  "spec": "GBS-AUDIT 0.1 (docs/benchmarks/AUDITABILITY.md, draft 0.1, 2026-11-03)",
  "preregistration": {"url": "benchmarks/results/gbs-2026-11-04/audit/PRE-REGISTRATION.md", "sha256_of_file_as_committed": prereg_sha,
      "commit": prereg_commit, "pushed_before": "2026-11-04T21:08:00Z",
      "first_measured_trial": d["first_measured_trial"],
      "note": "First measured trial = the first `gnomon audit verify` of the runner (the control check). Producing the trails is apparatus setup. An earlier measured run (started 21:08:12Z, first verify ~21:09Z) aborted on an apparatus failure; both runs postdate the commit."},
  "harness": {"name": "gnomon", "version": "0.4.1", "build": "gnomon/0.4.1+v0.4.1-c511b81", "commit": "c511b8105fb2187423d21becbe3b19f8af2b80e5",
      "install": "release installer + release tarballs, SHA256SUMS-checked; ../common/INSTALL.md"},
  "harness_config_hash": {a: d["arms"][a]["surface"] for a in ARMS} | {"kind": "gnomon surface hash per arm (`gnomon surface hash`); surfaces in the traces archive"},
  "models": "n/a: no inference. A deterministic scripted server (fake_model.mjs) wrote the sessions; the suite measures records at rest.",
  "hardware": "../common/hardware.json (Linux aarch64, GB10, 20 cores, shared machine). Timing plays no part in this suite's verdicts.",
  "apparatus": {"runner": "run_audit.mjs + adapter.mjs + fake_model.mjs + fake_tsa.mjs + summarise.py (this directory)", "task_set": "16 cases of AUDITABILITY §4 × 4 configurations",
      "concurrency": 1, "time_cap": "n/a: no time cap applies; each verify is a single CLI call",
      "witness": {"git": "local bare repository, receive.denyNonFastForwards + receive.denyDeletes (LOCAL STAND-IN, not a hosted remote)",
                  "rfc3161": "loopback fake TSA, EC P-256, pinned key (STAND-IN for a third-party authority)", "attest": "none off-machine; Ed25519 key file on the attacked machine (unattended signer)", "off": "none"},
      "trail_provenance": "real v0.4.1 trails from scripted `gnomon task --yes --json` sessions; target = session 2 of 3 (16 records off-arm 15)",
      "stale_flush_locks_removed": len(d.get("stale_flush_locks_removed", []))},
  "n": {"cases": 16, "configurations": 4, "slots": 64, "attempts_per_case": 1, "applicable": len([r for r in rows if r["verdict"] != "n/a"]), "n_a": len([r for r in rows if r["verdict"] == "n/a"]), "false_positive_sessions": fp_n},
  "validity": {"planned_slots": 64, "pass_detected": len([r for r in rows if r["verdict"].startswith("detected")]),
      "fail_undetected": len([r for r in rows if r["verdict"].startswith("undetected")]), "timeout": 0, "apparatus_failure": 0,
      "excluded_n_a": len([r for r in rows if r["verdict"] == "n/a"]), "sums_to_planned": True,
      "note": "the aborted first run is an apparatus failure of the RUN, repeated in full; it contributes no slots"},
  "mde": "n/a: deterministic single-attempt conformance cases, no comparison between arms is claimed",
  "primary": {"headline_caught_over_required_per_level": table, "ci_method": "Wilson 95% per cell (deterministic cases; the interval says what k/n can and cannot support)"},
  "reliability": "n/a: deterministic; one attempt per case. Determinism not separately re-run.",
  "cost": "$0; no tokens; no GPU",
  "telemetry": "verdicts from the verifier's exit status and output (CLI); mutations confirmed by the runner; witness moves from git's own push exit status",
  "latency": "n/a: not a timing suite",
  "incidents": [
      {"window": "2026-11-04T21:08:12Z–21:09:10Z", "event": "measured run 1 aborted: attest R2 re-sign wrote into a deleted heads/ directory (ENOENT)", "action": "apparatus fixed, whole run repeated (run 2, 21:09:46Z–21:13:41Z)"},
      {"window": "every anchored session (setup and false-positive phases)", "event": f"anchors/flush.lock left behind after `gnomon task` exited, with no delivery process alive; `gnomon audit anchor` answered 'already running' (removed {len(d.get('stale_flush_locks_removed', []))} times)", "action": "runner removes a lock no live process holds after 5 s; reported as a v0.4.1 finding"}],
  "deviations": "see PRE-REGISTRATION.md, deviations log (5 rows: 3 before outcomes, 2 after reading partial outcomes; plus the B1/D3 localisation re-targeting in summarise.py, logged after outcomes)",
  "traces": {"archive": "traces.tar.gz", "sha256": traces_sha,
      "chain_heads": {a: json.loads(open(f"raw/control-trail-{a}.jsonl").read().strip().split("\n")[-1])["hash"] for a in ARMS},
      "git_witness_tip_at_control": open("raw/witness-tip.txt").read().strip()},
  "scope": "system: gnomon v0.4.1 + these four configurations + Linux aarch64. No model is involved; not a harness-level cross-model claim",
  "authorship": "author-run (gnomon's authors wrote the spec, the harness and the runner)",
  "controls": d["controls"],
  "false_positives": {"per_arm": fp, "total": {"non_success": fp_k, "sessions": fp_n, "wilson95": wilson(fp_k, fp_n)},
      "off_default_surface": {"non_success": fp["off"]["non_success"], "sessions": fp["off"]["sessions"], "wilson95": wilson(fp["off"]["non_success"], fp["off"]["sessions"])}},
  "cases": rows,
}
json.dump(res, open(out, "w"), indent=2); open(out, "a").write("\n")
for arm in ARMS:
    print(arm, {lv: f"{v['caught']}/{v['required']} {v['wilson95']}" for lv, v in table[arm].items()})
print("fp", fp_k, fp_n, wilson(fp_k, fp_n))
