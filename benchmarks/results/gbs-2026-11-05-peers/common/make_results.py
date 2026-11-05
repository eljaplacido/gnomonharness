#!/usr/bin/env python3
"""Writes <spec>/result.json for each spec of this run (every GBS-REPORTING 0.2 §2.2 field), from the
analysis files beside them. Run from the run directory after the analyses:
  python3 -I common/make_results.py
"""
import json, math
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
BRANCH = "https://github.com/eljaplacido/gnomonharness/blob/bench/gbs-v02/benchmarks/results/gbs-2026-11-05-peers"
PREREG = {"commit": "181c8f2e9815cb42f1670ad7f0face05bec7f1d5", "committed": "2026-11-05T14:02:44Z", "first_measured_trial": "2026-11-05T14:03:05Z",
          "sha256": {"chaos": "af813f32b3bbb6ee62017653a55359dfb980f3e194bfa6e2917ccf27e9ee57b1", "overhead": "66f8dd6dc3884d9aa849099388b89463b77bc83014cf852c28fe26b45798186c",
                     "governance": "0600ed8f1ab84af9dc17cf2c42d9364df8bcee75076a5475c0906b8c716a6444", "audit": "ebd1e0099f3ee122282fdf2848c783a7c56a98b4422d1a9928f4b3cee4f72e5b"}}
HARNESSES = {
    "opencode": {"name": "opencode", "version": "v2.2.5 (V2 line)", "install": "GitHub release asset opencode-linux-arm64.tar.gz (anomalyco/opencode), inside the gbs05 image; never on the host",
                 "artifacts": {"opencode-linux-arm64.tar.gz": "5a528f42caf576c6cdece6a191eb273d3db54effa5518e0402684d8f8026aeb6",
                               "opencode (binary)": "dcc7e6f4ac1672e1884dcb8d26ab333e55ffc3f080e01a7a60177aa05f54935f"},
                 "installer": "none (tar xzf of the release asset; digest enforced in common/Dockerfile)", "runtime": "Bun 1.4.4, embedded"},
    "gnomon": {"name": "gnomon", "version": "0.4.2", "build": "gnomon/0.4.2+v0.4.2-2498d16", "install": "the release-tarball path of the release's own installer, inside the gbs05 image",
               "artifacts": {"gnomon-harness-0.4.2.tgz": "fc423ea6b99e06004d8f23fa3c68d74668a97516135a5ad9bec41ad74ea52b48",
                             "gnomon-core-0.4.2.tgz": "6600766d2fe6b3744de1c9557089156e0ba1fba61c844443e444f5b68494d751",
                             "gnomon-natives-0.4.2.tgz": "5e8ad51b79cf4e017e8bad6dabbf3748c42c6eee1c6c66f9bae50847f9644b31",
                             "gnomon-tui-0.4.2.tgz": "56e4d092ba7feeda08e83c45a5a0d8cda4baaa10aeb9452a5145b4ab1dcb502c",
                             "gnomon-0.4.2-linux-arm64.tar.gz": "a7e38ff8f43d4957e3578a0f78290710037b020c25442b04fb0c9476a10f7edb"},
               "installer": "replicated in common/Dockerfile (npm install -g of the four tarballs; natives into ~/.local/share/gnomon/bin), every file checked against the release SHA256SUMS",
               "runtime": "Node v22.23.2"},
}
HARDWARE = {"platform": "Linux aarch64 (Docker container on the host)", "host": "NVIDIA GB10: 10 x Cortex-X925 + 10 x Cortex-A725, 121 GiB, Ubuntu 24.04, kernel 6.17",
            "container": "gbs05-base:2026-11-05 sha256:20a68218b0c32c9995d6d82e59d7afba602b0155bad335650b3f2c2cf4fc7925 (Debian 12, node:22-slim pinned); run image gbs05-run:181c8f2e sha256:be19191d3f8230266847b62388df1e340c7f9b5f572c585cf5660067f6ed78e8",
            "hardware_class": "n/a (no class defined by these specs)", "shared": "yes: H3, R4H and G1 benchmarks ran on the same host, untouched"}
COMMON = {"models": "none: every model is a scripted fake on the container's loopback ($0); no real model server was called",
          "cost": {"total_usd": 0, "note": "no model calls"}, "scope": "n/a (harness level: the model is a script)",
          "authorship": "author-run: gnomon's authors wrote the specs, the runners, the endpoint, the corpus and opencode's best-effort configuration. Run by Claude Code (Opus 5.5) for the gnomon project. opencode's maintainers have not yet been notified; the result is held 14 days after notice (README, How to submit)",
          "mde": "n/a (profile)", "primary": "n/a (profile)", "reliability": "n/a (profile; deterministic scripted runs)"}


def wilson_half(n):
    if n == 0:
        return None
    z = 1.959964; p = 0.5; den = 1 + z * z / n
    return round(100 * z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den, 1)


def prereg(spec):
    return {"url": f"{BRANCH}/{spec}/PRE-REGISTRATION.md", "sha256_as_committed": PREREG["sha256"][spec], "commit": PREREG["commit"],
            "committed_utc": PREREG["committed"], "first_measured_trial_utc": PREREG["first_measured_trial"]}


def dev_rows(spec):
    t = (HERE / spec / "PRE-REGISTRATION.md").read_text().split("## Deviations log", 1)[1]
    return [l.strip() for l in t.splitlines() if l.startswith("| 2026")]


def write(spec, d):
    (HERE / spec / "result.json").write_text(json.dumps(d, indent=1) + "\n")


# ── CHAOS ──
c = json.loads((HERE / "chaos/analysis.json").read_text())
runs = c["runs"]
write("chaos", dict(COMMON, spec="GBS-CHAOS 0.2 (draft), reported under GBS-REPORTING 0.2 (draft)", level="harness: every harness-level requirement met for both harnesses (lane check by §5.2a + §5.2b; unsupported cases per CHAOS-11/CHAOS-9)",
    result_type="profile (two harnesses side by side; no comparison claim)", preregistration=prereg("chaos"),
    harness=[HARNESSES["opencode"], HARNESSES["gnomon"]],
    harness_config_hash={"opencode": runs["opencode-seed1"]["config_hash"], "gnomon": runs["gnomon-seed1"]["config_hash"], "files": "opencode: config_files on raw/chaos-opencode-1/opencode-seed1.json; gnomon: chaosSurfaceFiles() of v0.4.2 (template hash)"},
    hardware=HARDWARE, apparatus={"runner": "chaos/blackbox.mjs @ 181c8f2e", "endpoint": "gnomon chaos serve, gnomon v0.4.2, --network none", "plan": "gnomon chaos list --json (v0.4.2): 20 faults, 37 cases",
                                  "cap": {"configured_s": 300, "measured_max_s": round(max(x["ms"] for r in runs.values() for x in r["cases"]) / 1000, 1)}, "concurrency": "one case at a time; the lane check's pair concurrently",
                                  "endpoint_build_lane_check": c["endpoint_build_lane_check"]},
    n={"cases_planned_per_run": 37, "runs": {k: "seed " + k[-1] for k in runs}, "trials_run": 37 * len(runs)},
    validity={k: {"fired": v["summary"]["cases_fired"], "unsupported": v["summary"].get("cases_unsupported", 0), "not_fired_unexplained": 37 - v["summary"]["cases_fired"] - v["summary"].get("cases_unsupported", 0),
                  "apparatus_failure": 0, "void": v["void"], "bucket_mapping": "fired -> announced | silent; unsupported (transport/task) counted apart; timeout is an injected fault, n/a as a bucket (REP-2)"} for k, v in runs.items()},
    resolution={"opencode": f"±{wilson_half(8)} points at n = 8 fired cases", "gnomon": f"±{wilson_half(37)} points at n = 37"},
    profile={k: {"faults_announced": [v["summary"]["faults_announced"], v["summary"]["faults"]], "cases_announced_of_fired": v["cases_announced_of_fired"],
                 "cases_unsupported": v["summary"].get("cases_unsupported", 0), "silent_failure_share": v["silent_failure_share"], "cases_recovered": v["summary"]["cases_recovered"],
                 "leaked": v["summary"]["leaked"], "per_fault": v["faults"]} for k, v in runs.items()},
    telemetry="the endpoint's own log (GET /chaos/log) for fired, billed tokens and leaks; channels from each harness's process (exit, stdout events/JSON record, stderr)",
    latency={k: {"case_ms_median": sorted(x["ms"] for x in v["cases"])[len(v["cases"]) // 2], "case_ms_max": max(x["ms"] for x in v["cases"])} for k, v in runs.items()},
    incidents=[], deviations=dev_rows("chaos"),
    traces={"archive": "raw/chaos-*/ (cards, work.tar.gz with every project and serve log); raw/SHA256SUMS", "chain_heads": "n/a"}))

# ── OVERHEAD ──
o = json.loads((HERE / "overhead/analysis.json").read_text())
write("overhead", dict(COMMON, spec="GBS-OVERHEAD 0.2 (draft), reported under GBS-REPORTING 0.2 (draft)",
    level="harness, partially: S0/S1 cold-process only; S2, S3, warm-session, cold-home and the component breakdown (MUST) not run",
    result_type="profile (each harness against its own runtime's null harness, paired; harnesses side by side, no comparison claim)", preregistration=prereg("overhead"),
    harness=[HARNESSES["opencode"], HARNESSES["gnomon"]], harness_config_hash=o["meta"]["config_hashes"],
    hardware=dict(HARDWARE, pinned_cores="5-9,15-19 (Cortex-X925) via docker --cpuset-cpus", load=o["load"]),
    apparatus={"runner": "overhead/overhead.py @ 181c8f2e", "fake_model": "in the runner process, loopback, chat completions (streamed and one-body)", "tool_map_opencode": o["meta"]["toolmap_opencode"],
               "opencode_flags": o["meta"]["opencode_flags"], "runtimes": {"node": o["meta"]["node"], "bun_in_opencode": o["meta"]["bun_in_opencode"]}},
    n={"rounds": 20, "cells": ["S0/d0", "S0/d250", "S1/d0", "S1/d250"], "arms": 8, "trials_planned": 640, "trials_run": sum(v["trials"] for v in o["validity"].values())},
    validity={a: {"valid": v["valid"], "trials": v["trials"], "invalid": v["invalid"]} for a, v in o["validity"].items()},
    resolution="n/a: CPU per trial is a continuous measure; paired medians with 95% bootstrap CIs over 20 rounds",
    profile={"cells": o["cells"], "paired": o["paired"]}, telemetry="process-tree rusage (user + sys, children included, under a child subreaper); request bytes from the fake model's log",
    latency="wall and harness wall per trial in profile.cells", incidents=[], deviations=dev_rows("overhead"),
    traces={"archive": "raw/overhead/main.jsonl.gz; raw/SHA256SUMS", "chain_heads": "n/a"}))

# ── GOVERNANCE ──
g = json.loads((HERE / "governance/summary.json").read_text())
write("governance", dict(COMMON, spec="GBS-GOVERNANCE 0.2 (draft), reported under GBS-REPORTING 0.2 (draft)",
    level="harness: G-2 (no adaptive arm: no family-level claim), G-3, G-4 compromised-model arm, G-1f; system-level rows (G-1 violation rate, G-4 high-compliance arm) not run",
    result_type="profile (four configurations side by side; no comparison claim)", preregistration=prereg("governance"),
    harness=[HARNESSES["opencode"], HARNESSES["gnomon"]],
    harness_config_hash={k: (v.get("meta") or {}).get("surface_hash") for k, v in g.items()},
    hardware=HARDWARE, apparatus={"runner": "governance/gov_peer.py @ 181c8f2e", "isolation": "docker --network none --add-host exfil.attacker.test:127.0.0.1, no host mounts; every attack executed",
                                  "corpus": "the 2026-11-04 corpus verbatim (corpus.py d9a6104c…, g2_corpus.py a6b51136…, fake_model.py 45d5e8df…)",
                                  "cap": {"configured_s": 120}, "concurrency": "four containers, one per configuration, on cores 0-4,10-14"},
    n={k: {"G-2": v["G-2"]["in-root"]["n"] + v["G-2"]["out-of-root"]["n"] + v["G-2"]["egress"]["n"] + v["G-2"]["history"]["n"], "G-2 everyday": v["G-2"]["everyday"]["n"],
           "G-4 attack trials (auto)": v["G-4"]["P_block_given_attempt_auto"]["n"], "G-3 runs per pass": v["G-3"]["auto"]["n"]} for k, v in g.items()},
    validity={k: {"positive_control": v["controls"]["positive"], "broken_tests_excluded": v["controls"]["broken_tests_excluded"],
                  "G-2 unattempted (apparatus)": v["G-2"]["apparatus_unattempted"], "G-4 apparatus": v["G-4"]["apparatus"]} for k, v in g.items()},
    resolution=f"±{wilson_half(70)} points for in-root G-2 (n = 70), ±{wilson_half(23)} for out-of-root/egress (n = 23), ±{wilson_half(280)} for G-4 P(block | attempt) (n = 280)",
    profile=g, telemetry="real state (tree hashes, git refs and config, session-store rows, the canary's own log, the model-bound channel); refusal text kept as a labelled diagnostic",
    latency="n/a", incidents=[], deviations=dev_rows("governance"),
    traces={"archive": "raw/gov-*/*.jsonl.gz; raw/SHA256SUMS", "chain_heads": "gnomon: the `heads` of each trial are not collected in this runner; n/a"}))

# ── AUDIT ──
a = json.loads((HERE / "audit/summary.json").read_text())
write("audit", dict(COMMON, spec="GBS-AUDIT 0.2 (draft), reported under GBS-REPORTING 0.2 (draft)",
    level="harness: scripted sessions (AUDIT-1, driver stated); the real-model false-positive corpus (system level) not run",
    result_type="profile", preregistration=prereg("audit"), harness=[HARNESSES["opencode"], HARNESSES["gnomon"]],
    harness_config_hash={"opencode": "shipped defaults + the fake-model provider (raw/audit-opencode/audit-opencode.json opencode_config)", "gnomon": "the 0.1 runner's four configurations: off, attest, git, rfc3161"},
    hardware=HARDWARE, apparatus={"runner": "audit/audit_oc.py and audit/gnomon/run_audit.mjs @ 181c8f2e", "witness": "gnomon: local bare repository and a fake TSA (stand-ins); opencode: none"},
    n={"opencode": "16 cases (8 run, 8 N/A) on session 2 of 3", "gnomon": "16 cases x 4 configurations, plus 48 false-positive sessions"},
    validity={"gnomon_controls_ok": a["gnomon-controls"]["controls_ok"], "opencode_mutations_took_effect": a["opencode"]["mutations_took_effect"]},
    resolution="n/a: deterministic cases are compared case by case (AUDIT-8)", profile=a,
    telemetry="the documented verifier's exit status (gnomon); none documented (opencode); opencode's `session export` kept as a diagnostic only",
    latency="n/a", incidents=[], deviations=dev_rows("audit"),
    traces={"archive": "raw/audit-*/; raw/SHA256SUMS", "chain_heads": "gnomon: in raw/audit-gnomon/raw/control-trail-*.jsonl"}))
print("ok")
