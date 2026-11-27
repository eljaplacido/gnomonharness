"""Unit tests for benchmarks/kit/validate_reporting.py (GBS-REPORTING v0.2)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

KIT_DIR = Path(__file__).resolve().parents[1]
if str(KIT_DIR) not in sys.path:
    sys.path.insert(0, str(KIT_DIR))

import validate_reporting as vr  # noqa: E402


def _valid_comparison() -> dict:
    return {
        "spec": "GBS-HYBRID 0.2",
        "level": "system",
        "result_type": "comparison",
        "preregistration": {"sha256": "abc", "commit": "1234567"},
        "harness": {"name": "gnomon", "version": "0.6.8"},
        "harness_config_hash": "deadbeef",
        "models": {"implement": {"model": "qwen3.6:35b"}},
        "hardware": {"os": "linux", "arch": "arm64"},
        "apparatus": {"configured_cap_s": 1800, "measured_cap_s": 1800},
        "n": {"tasks": 20, "attempts": 3, "trials_planned": 60, "trials_run": 60},
        "validity": {"pass": 40, "fail": 15, "timeout": 3, "apparatus_failure": 2, "excluded": 0},
        "mde": {"value": 0.10, "alpha": 0.05},
        "resolution": "n/a (comparison)",
        "primary": {"estimate": 0.12, "ci95": [0.02, 0.22]},
        "profile": "n/a (comparison)",
        "reliability": {"pass_at_1": 0.67, "pass_pow_2": 0.58},
        "cost": {"total_usd": 0.0},
        "telemetry": "wire capture",
        "latency": {"median_s": 42.0, "p90_s": 110.0},
        "incidents": [],
        "deviations": [],
        "traces": {"url": "local", "sha256": "000"},
        "scope": "system",
        "authorship": "author-run",
    }


class TestValidateReporting(unittest.TestCase):
    def test_valid_comparison_passes(self) -> None:
        self.assertEqual(vr.validate_result(_valid_comparison()), [])

    def test_missing_field_is_caught(self) -> None:
        doc = _valid_comparison()
        del doc["telemetry"]
        errs = vr.validate_result(doc)
        self.assertTrue(any("telemetry" in e for e in errs))

    def test_validity_denominator_mismatch_is_caught(self) -> None:
        doc = _valid_comparison()
        doc["validity"]["timeout"] = 0  # sums to 57 != 60
        errs = vr.validate_result(doc)
        self.assertTrue(any("57" in e and "60" in e for e in errs))

    def test_profile_requires_resolution_and_profile(self) -> None:
        doc = _valid_comparison()
        doc["result_type"] = "profile"
        errs = vr.validate_result(doc)
        self.assertTrue(any("resolution" in e for e in errs))
        self.assertTrue(any("profile" in e for e in errs))


if __name__ == "__main__":
    unittest.main()
