#!/usr/bin/env python3
"""Build GBS-REPORTING v0.2 conformant result.json for v0.6.8 live campaigns."""
from __future__ import annotations

import json
import platform
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def hardware_info() -> dict:
    uname = platform.uname()
    return {
        "platform": f"{uname.system} {uname.machine}",
        "os": platform.platform(),
        "kernel": uname.release,
        "node": subprocess.check_output(["node", "-v"], text=True).strip(),
        "python": platform.python_version(),
        "machine": "gx10 (NVIDIA GB10, local llama-server :18080)",
    }


def build_ab_result(
    result_dir: Path,
    *,
    spec: str,
    prereg_path: str,
    prereg_commit: str,
    baseline: str,
    candidate: str,
    mde_desc: str,
    deviations: list[str],
) -> dict:
    summary = json.loads((result_dir / "summary.json").read_text(encoding="utf-8"))
    analysis = json.loads((result_dir / "analysis.json").read_text(encoding="utf-8"))
    arms = summary["arms"]
    contrast = analysis["contrasts"][0]

    planned = sum(a["cells"] for a in arms.values())
    total_solves = sum(a["solves"] for a in arms.values())
    total_valid = sum(a["valid"] for a in arms.values())
    total_apparatus = sum(a["apparatus_failures"] for a in arms.values())
    total_fail = total_valid - total_solves

    base_arm = arms[baseline]
    cand_arm = arms[candidate]

    # Parse tool_log edit failure entries from cells.jsonl (covers stale-anchor / edit-refused
    # messages that return as tool errors rather than policy refusals in counters.per_tool).
    edit_log_failures = {baseline: 0, candidate: 0}
    edit_log_total = {baseline: 0, candidate: 0}
    jsonl_path = result_dir / "cells.jsonl"
    if jsonl_path.exists():
        for line in jsonl_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            arm_name = r.get("arm")
            if arm_name not in edit_log_total or r.get("valid") != 1:
                continue
            for entry in r.get("tool_log") or []:
                if isinstance(entry, str) and entry.startswith("edit"):
                    edit_log_total[arm_name] += 1
                    low = entry.lower()
                    if any(k in low for k in ("stale", "refus", "fail", "error", "not found", "mismatch", "invalid", "no match", "ambiguous")):
                        edit_log_failures[arm_name] += 1

    doc = {
        "spec": spec,
        "level": "harness",
        "result_type": "comparison",
        "preregistration": {
            "url": prereg_path,
            "commit": prereg_commit,
        },
        "harness": {
            "name": "gnomon",
            "version": "0.6.8",
            "build": summary.get("harness", ""),
            "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        },
        "harness_config_hash": {
            arm: info["surface_hashes"] for arm, info in arms.items()
        },
        "models": [
            {
                "id": summary["model"],
                "endpoint": summary["endpoint"],
                "lane": "local",
                "billing": "$0 (local llama-server)",
            }
        ],
        "hardware": hardware_info(),
        "apparatus": {
            "runner": "benchmarks/v068-ab/run.mjs",
            "suite": summary["suite"],
            "tasks": summary["tasks"],
            "waves": summary["waves"],
            "order": "interleaved, alternating arm order by wave",
            "isolation": "fresh temp HOME, XDG_DATA_HOME, git repo per cell; hidden tests held outside workspace",
        },
        "n": {
            "tasks": len(summary["tasks"]),
            "waves": summary["waves"],
            "arms": len(arms),
            "trials_planned": planned,
            "trials_run": planned,
        },
        "validity": {
            "pass": total_solves,
            "fail": total_fail,
            "timeout": 0,
            "apparatus_failure": total_apparatus,
            "excluded": 0,
            "sum_equals_planned": (total_solves + total_fail + total_apparatus) == planned,
        },
        "mde": mde_desc,
        "resolution": "n/a: comparison result (see mde and primary bootstrap/sign-flip 95% CIs)",
        "primary": {
            "contrast": f"{candidate} - {baseline}",
            "solved": contrast["solved"],
            "hidden_share": contrast["hidden_share"],
            "mechanism": {
                baseline: {
                    "edit_calls": base_arm["edit_calls"],
                    "edit_refusals_counter": base_arm["edit_refusals"],
                    "edit_tool_log_failures": edit_log_failures[baseline],
                    "edit_tool_log_failure_rate": round(edit_log_failures[baseline] / edit_log_total[baseline], 4) if edit_log_total[baseline] else 0.0,
                    "cells_with_edit_refusal": base_arm["cells_with_edit_refusal"],
                    "worktree_changed_cells": base_arm["worktree_changed_cells"],
                    "false_result_no_change": base_arm["false_result_no_change"],
                    "stop_reasons": base_arm["stop_reasons"],
                },
                candidate: {
                    "edit_calls": cand_arm["edit_calls"],
                    "edit_refusals_counter": cand_arm["edit_refusals"],
                    "edit_tool_log_failures": edit_log_failures[candidate],
                    "edit_tool_log_failure_rate": round(edit_log_failures[candidate] / edit_log_total[candidate], 4) if edit_log_total[candidate] else 0.0,
                    "cells_with_edit_refusal": cand_arm["cells_with_edit_refusal"],
                    "worktree_changed_cells": cand_arm["worktree_changed_cells"],
                    "false_result_no_change": cand_arm["false_result_no_change"],
                    "stop_reasons": cand_arm["stop_reasons"],
                },
            },
        },
        "profile": "n/a: comparison result (not a profile study)",
        "reliability": {
            "per_arm_solve_rate": {
                baseline: base_arm["solve_rate"],
                candidate: cand_arm["solve_rate"],
            },
            "per_arm_hidden_share": {
                baseline: base_arm["mean_hidden_share"],
                candidate: cand_arm["mean_hidden_share"],
            },
        },
        "cost": {
            "usd_total": 0.0,
            "note": "Local llama-server inference ($0 cloud spend)",
            "tokens": {
                arm: {
                    "tokens_in_total": info["tokens_in_total"],
                    "tokens_out_total": info["tokens_out_total"],
                    "mean_tokens_in": info["mean_tokens_in"],
                    "mean_tokens_out": info["mean_tokens_out"],
                }
                for arm, info in arms.items()
            },
        },
        "telemetry": {
            "audit_enabled": True,
            "audit_record": "metadata",
            "audit_chain": True,
            "mean_tool_steps": {arm: info["mean_tool_steps"] for arm, info in arms.items()},
        },
        "latency": {
            "mean_wall_s": {arm: info["mean_wall_s"] for arm, info in arms.items()},
            "started_at": summary["started_at"],
            "finished_at": summary["finished_at"],
        },
        "incidents": [],
        "deviations": deviations,
        "traces": {
            "cells_csv": str((result_dir / "cells.csv").relative_to(ROOT)),
            "cells_jsonl": str((result_dir / "cells.jsonl").relative_to(ROOT)),
            "analysis_json": str((result_dir / "analysis.json").relative_to(ROOT)),
            "analysis_txt": str((result_dir / "analysis.txt").relative_to(ROOT)),
        },
        "scope": "system",
        "authorship": "author-run",
    }
    (result_dir / "result.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return doc


def build_st0_result(result_dir: Path, prereg_commit: str) -> dict:
    report = json.loads((result_dir / "trial_report.json").read_text(encoding="utf-8"))
    meta = json.loads((result_dir / "run_meta.json").read_text(encoding="utf-8"))
    pairs = report.get("pairs", {})
    cells = report.get("cells", {})
    ep_pass = report.get("endpoints", {}).get("pass", {})
    planned = int(cells.get("total", pairs.get("planned", 0) * 2))
    base_passes = int(ep_pass.get("base", {}).get("passes", 0))
    skill_passes = int(ep_pass.get("skill", {}).get("passes", 0))
    passed = base_passes + skill_passes
    app_fail = int(cells.get("apparatus_failure", 0))
    failed = planned - passed - app_fail

    doc = {
        "spec": "ST0 negative control (benchmarks/results/st-2026-11/PRE-REGISTRATION.md), GBS-REPORTING v0.2",
        "level": "harness",
        "result_type": "comparison",
        "preregistration": {
            "url": "benchmarks/results/st-2026-11/PRE-REGISTRATION.md",
            "commit": prereg_commit,
        },
        "harness": {
            "name": "gnomon",
            "version": "0.6.8",
            "build": report.get("harness", ""),
            "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        },
        "harness_config_hash": {
            "base_surface_hash": report.get("arms", {}).get("base", {}).get("surface_hash", ""),
            "skill_surface_hash": report.get("arms", {}).get("skill", {}).get("surface_hash", ""),
            "base_cell_surface_hash": report.get("arms", {}).get("base", {}).get("cell_surface_hash", ""),
            "skill_cell_surface_hash": report.get("arms", {}).get("skill", {}).get("cell_surface_hash", ""),
            "differ": report.get("arms", {}).get("differ", []),
        },
        "models": [
            {
                "id": meta["model"],
                "endpoint": meta["endpoint"],
                "lane": "local",
                "billing": "$0 (local llama-server)",
            }
        ],
        "hardware": hardware_info(),
        "apparatus": {
            "runner": "benchmarks/v068-ab/run_st0*.mjs -> gnomon skill trial skip-tests --json --trust --yes",
            "trial_schema": report.get("schema", ""),
            "verify_gate": "off (per ST0 pre-registration)",
            "order": "interleaved",
            "attempts": meta["attempts"],
        },
        "n": {
            "pairs_planned": pairs.get("planned", 0),
            "pairs_valid": pairs.get("valid", 0),
            "attempts": meta["attempts"],
            "arms": 2,
            "trials_planned": planned,
            "trials_run": planned,
        },
        "validity": {
            "pass": passed,
            "fail": failed,
            "timeout": 0,
            "apparatus_failure": app_fail,
            "excluded": 0,
            "sum_equals_planned": (passed + failed + app_fail) == planned,
        },
        "mde": report.get("mde", "6 discordant pairs all one way at alpha=0.05"),
        "resolution": "n/a: comparison result",
        "primary": {
            "meets_thresholds": report.get("meets_thresholds"),
            "exit_code": meta["exit_code"],
            "status": report.get("status"),
            "reasons": report.get("reasons", []),
            "endpoints": report.get("endpoints"),
            "thresholds": report.get("thresholds"),
            "st0_strict_false_reached": report.get("meets_thresholds") is False and meta["exit_code"] == 2,
            "false_positive_acceptance": report.get("meets_thresholds") is True,
        },
        "profile": "n/a: comparison result",
        "reliability": {
            "cells_buckets": cells,
            "pass_endpoint": ep_pass,
        },
        "cost": {
            "usd_total": 0.0,
            "note": "Local llama-server inference ($0 cloud spend)",
            "budget": report.get("budget"),
        },
        "telemetry": {
            "audit_enabled": True,
            "trial_schema": report.get("schema", ""),
            "leftovers": report.get("leftovers", []),
        },
        "latency": {
            "wall_s_total": meta["wall_s"],
            "wall_ms_endpoints": report.get("endpoints", {}).get("wall_ms"),
            "timestamp": meta["timestamp"],
        },
        "incidents": [],
        "deviations": [
            "Ran on local OpenAI-compatible llama-server :18080 (qwen3.6-35b) rather than Ollama local_first default URL; single fixed model across all cells."
        ],
        "traces": {
            "trial_report_json": str((result_dir / "trial_report.json").relative_to(ROOT)),
            "run_meta_json": str((result_dir / "run_meta.json").relative_to(ROOT)),
        },
        "scope": "system",
        "authorship": "author-run",
    }
    (result_dir / "result.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return doc


if __name__ == "__main__":
    mode = sys.argv[1]
    out_dir = Path(sys.argv[2]).resolve()
    if mode == "hashline":
        build_ab_result(
            out_dir,
            spec="E-HASHLINE (benchmarks/results/v068-nextgen/PRE-REGISTRATION.md), GBS-REPORTING v0.2",
            prereg_path="benchmarks/results/v068-nextgen/PRE-REGISTRATION.md",
            prereg_commit="af786126c",
            baseline="str_replace",
            candidate="hashline",
            mde_desc="11 tasks x 3 paired waves (33 paired cells/arm); mechanism endpoint (edit failure rate) directly resolvable; pass-rate MDE ~25-30pp at n=11 tasks",
            deviations=[
                "11 brownfield multi-hunk tasks (9 Python, 2 Node ESM) x 3 waves = 66 live cells (draft pre-registration targeted 24 tasks; scoped to 11 multi-hunk tasks to fit single-GPU local inference window).",
                "Role omitted `write` and restricted `bash_allow` to unittest/node-test/ls so 100% of file edits route through `edit`, eliminating shell-edit confounding.",
            ],
        )
    elif mode == "reqchange":
        build_ab_result(
            out_dir,
            spec="E-REQCHANGE Regime A natural prompts (benchmarks/results/v068-nextgen/PRE-REGISTRATION.md), GBS-REPORTING v0.2",
            prereg_path="benchmarks/results/v068-nextgen/PRE-REGISTRATION.md",
            prereg_commit="af786126c",
            baseline="off",
            candidate="on",
            mde_desc="8 tasks x 3 paired waves (24 paired cells/arm); primary mechanism endpoint is hard contract check (false bucket=='result' with worktree_changed==0 must drop to 0/24)",
            deviations=[
                "8 bugfix tasks x 3 waves = 48 live cells (draft pre-registration targeted 20 tasks). Because qwen3.6-35b edited files on 24/24 baseline cells, a companion catchable-population run (v068-reqchange-catch-2026-11-28) was executed to exercise the hand-back mechanism directly.",
            ],
        )
    elif mode == "reqchange-catch":
        build_ab_result(
            out_dir,
            spec="E-REQCHANGE Regime B catchable population (benchmarks/results/v068-nextgen/PRE-REGISTRATION.md), GBS-REPORTING v0.2",
            prereg_path="benchmarks/results/v068-nextgen/PRE-REGISTRATION.md",
            prereg_commit="af786126c",
            baseline="off",
            candidate="on",
            mde_desc="6 plan-first tasks x 2 paired waves (12 paired cells/arm); primary mechanism endpoint is hard contract check (false bucket=='result' with worktree_changed==0 drops to 0/12)",
            deviations=[
                "Companion catchable-population run where prompts invite diagnosis/plan-first prose unless the harness requires a file change, isolating the exact unchanged-worktree failure mode #273 targets.",
            ],
        )
    elif mode == "st0":
        build_st0_result(out_dir, prereg_commit="af786126c")
    else:
        raise SystemExit(f"Unknown mode: {mode}")
    print(f"Wrote {out_dir / 'result.json'}")
