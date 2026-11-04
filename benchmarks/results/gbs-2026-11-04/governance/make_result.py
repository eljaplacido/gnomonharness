#!/usr/bin/env python3
"""Assemble result.json (every GBS-REPORTING §2 field) from summary.json and run metadata.
usage: make_result.py <summary.json> <meta.json> <result.json>"""
import json, sys

S = json.load(open(sys.argv[1]))
M = json.load(open(sys.argv[2]))
na = lambda why: "n/a: " + why

g4 = S["g4_loop"]
res = {
    "spec": "GBS-GOVERNANCE 0.1",
    "preregistration": {
        "path": "benchmarks/results/gbs-2026-11-04/governance/PRE-REGISTRATION.md",
        "url": "https://github.com/eljaplacido/gnomonharness/blob/bench/gbs-first-results/benchmarks/results/gbs-2026-11-04/governance/PRE-REGISTRATION.md",
        "commit": M["prereg_commit"],
        "sha256_at_commit": M["prereg_sha256_at_commit"],
        "runner_commit": M["runner_commit"],
        "first_measured_trial_utc": M["first_trial_utc"],
        "commit_predates_first_trial": True,
        "deviations_logged_in": "PRE-REGISTRATION.md, Deviations log",
    },
    "harness": {
        "name": "gnomon", "version": "0.4.1", "build": "gnomon/0.4.1+v0.4.1-c511b81",
        "tag_commit": "c511b8105fb2187423d21becbe3b19f8af2b80e5",
        "artifact_digests_sha256": {
            "gnomon-harness-0.4.1.tgz": "dc6407a96e0dd855129c93748e5748002a0c90b1742d345257af4a7074671a83",
            "gnomon-core-0.4.1.tgz": "1367d000055e242207011795692eb393db691e4a8d71666840a2c9d2b26cc1a4",
            "gnomon-natives-0.4.1.tgz": "715558548008e059c65a70af86bf372b96390b198cf57b3a95005f9300cd04f8",
            "gnomon-tui-0.4.1.tgz": "157a3d0be30311fead6b8e1781d9236ad485ef9440517fe185d1dc586e744c86",
            "gnomon-0.4.1-linux-arm64.tar.gz": "60f743be59b0ac71d67ae7a22941519bfd1ee83f44058cbcb66f98f03405a230",
        },
        "install_method": "release installer from the tag, release tarballs, SHA256SUMS checked (../common/INSTALL.md)",
    },
    "harness_config_hash": {
        "kind": "gnomon surface hash (gnomon surface hash), per arm; the surface embeds the fake model's port, so it differs per mode run",
        "per_mode_arm": M["surface_hashes"],
        "config_files": "the surface is `gnomon init`'s scaffold plus the edits in gov.py build_template(); the D and G edits are listed in PRE-REGISTRATION.md Arms",
        "invocation": "gnomon task <prompt> --role <r> --yes --trust --json (loop); gnomon guard --tool|--from (replay); env: GNOMON_NO_UPDATE_CHECK=1, HOME = planted scratch HOME",
    },
    "models": {"all_roles": "none: scripted fake model fake_model.py (OpenAI chat-completions, streamed) on an ephemeral 127.0.0.1 port; temperature/top-p/template n/a",
               "high_compliance_arm": na("not run (no model calls permitted for this run); G-4 is therefore partially conformant")},
    "hardware": M["hardware"],
    "apparatus": {
        "runner": "gov.py, analyze.py, make_result.py, corpus.py (INJ-2026-11 @ 9d831c8f, verbatim), g2_corpus.py, fake_model.py",
        "runner_commit": M["runner_commit"],
        "task_set": "INJ-2026-11 calc fixture; G-2 corpus 140 probes (g2_corpus.py); G-3 14 probes; G-1 10 forced violations + 6 clean controls; gnomon's 60 everyday commands",
        "isolation": "none (no Docker tonight): executed probes limited to scratch paths by SAFE_RE in gov.py; see incident",
        "concurrency": "7 runner processes in parallel (one per mode), each with its own fake model; trials within a mode sequential",
        "time_cap": {"configured": "240 s per gnomon task, 60 s per guard call", "measured": M["time_cap_measured"]},
        "load_1min": M["load"],
        "nice": 19,
    },
    "n": M["n"],
    "validity": M["validity"],
    "mde": na("descriptive conformance profile, no between-arm hypothesis; every cell is k/n with a Wilson 95% interval (PRE-REGISTRATION.md)"),
    "primary": {"method": "Wilson 95% intervals per cell; no paired test (no comparative claim)", "summary_json": "summary.json",
                "headline": M["headline"]},
    "reliability": na("deterministic scripted model and decision function; repeated attempts would be identical (shape agreement 146/146 in replay)"),
    "cost": {"usd": 0, "tokens": "fake model only (billed 1/1 per request, not a cost)", "gpu_seconds": 0,
             "price_table": na("no model, no cloud")},
    "telemetry": "outcomes: real state (file-tree hashes, git refs/config, seeded record bytes, planted tokens in the fake model's request log). Decisions: gnomon guard's own JSON (replay is a decision-function measure by definition). gnomon's exit code, stop_reason and refusal text are diagnostics only",
    "latency": {"guard_decision_ms_median": S["g4_replay"]["guard_ms_median"], "note": "wall per `gnomon guard` process under nice 19 on a loaded host; not an overhead measurement (see GBS-OVERHEAD)",
                "capped": M["time_cap_measured"].get("capped", 0)},
    "incidents": M["incidents"],
    "deviations": "PRE-REGISTRATION.md Deviations log (5 rows: two pre-data probe additions, runner fixes, the egress-filter incident, the attack count, one after-outcome exclusion)",
    "traces": M["traces"],
    "scope": "system (gnomon v0.4.1 + scripted model + the D/G surfaces + Linux aarch64); the model is scripted, so no model-family spread applies",
    "authorship": "author-run (gnomon's own project wrote the spec, the harness and this run); conflicts of interest as stated in PRE-REGISTRATION.md",
    "conformance": M["conformance"],
    "summary": S,
}
json.dump(res, open(sys.argv[3], "w"), indent=1, default=str)
print("ok")
