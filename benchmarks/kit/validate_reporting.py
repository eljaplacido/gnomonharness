#!/usr/bin/env python3
"""GBS-REPORTING v0.2 validator (benchmarks/kit/standards/REPORTING.md).

Stdlib-only validator checking that a `result.json` document conforms to
GBS-REPORTING §2.2:
  - Every required field is present (never omitted; inapplicable fields must
    be explicitly written as "n/a" or {"value": "n/a", "reason": "..."}).
  - `level` is "harness" or "system".
  - `result_type` is "comparison" or "profile", with matching fields present.
  - `validity` buckets sum to `n.trials_planned` when integer counts are given.
  - `authorship` names "author-run" or "third-party".

Exit 0 when valid, 1 when one or more contract violations are found, 2 on usage/parse error.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REQUIRED_FIELDS: tuple[str, ...] = (
    "spec",
    "level",
    "result_type",
    "preregistration",
    "harness",
    "harness_config_hash",
    "models",
    "hardware",
    "apparatus",
    "n",
    "validity",
    "mde",
    "resolution",
    "primary",
    "profile",
    "reliability",
    "cost",
    "telemetry",
    "latency",
    "incidents",
    "deviations",
    "traces",
    "scope",
    "authorship",
)

VALID_LEVELS = {"harness", "system"}
VALID_RESULT_TYPES = {"comparison", "profile"}
VALID_SCOPES = {"system", "cross-model", "n/a"}
VALID_AUTHORSHIP = {"author-run", "third-party"}
VALIDITY_BUCKETS = ("pass", "fail", "timeout", "apparatus_failure", "excluded")


def _is_na(val: Any) -> bool:
    if isinstance(val, str):
        return val.strip().lower().startswith("n/a")
    if isinstance(val, dict):
        return str(val.get("value", "")).strip().lower() == "n/a" or val.get("na") is True
    return False


def validate_result(doc: Any) -> list[str]:
    """Return a list of GBS-REPORTING v0.2 violations (empty means conformant)."""
    if not isinstance(doc, dict):
        return ["root must be a JSON object"]

    errors: list[str] = []
    for field in REQUIRED_FIELDS:
        if field not in doc or doc[field] is None:
            errors.append(f"missing required field: {field}")

    level = doc.get("level")
    if isinstance(level, dict):
        level_val = level.get("value") or level.get("kind")
    else:
        level_val = level
    if level is not None and level_val not in VALID_LEVELS:
        errors.append(f"level must be one of {sorted(VALID_LEVELS)}, got {level!r}")

    rtype = doc.get("result_type")
    if rtype is not None and rtype not in VALID_RESULT_TYPES:
        errors.append(f"result_type must be one of {sorted(VALID_RESULT_TYPES)}, got {rtype!r}")

    if rtype == "comparison":
        for f in ("mde", "primary"):
            if f in doc and doc[f] is not None and _is_na(doc[f]):
                errors.append(f"comparison result cannot mark '{f}' as n/a")
    elif rtype == "profile":
        for f in ("resolution", "profile"):
            if f in doc and doc[f] is not None and _is_na(doc[f]):
                errors.append(f"profile result cannot mark '{f}' as n/a")

    scope = doc.get("scope")
    if isinstance(scope, dict):
        scope_val = scope.get("value")
    else:
        scope_val = scope
    if scope is not None and not _is_na(scope) and scope_val not in VALID_SCOPES:
        errors.append(f"scope must be one of {sorted(VALID_SCOPES)}, got {scope!r}")

    auth = doc.get("authorship")
    auth_val = auth.get("kind") or auth.get("type") if isinstance(auth, dict) else auth
    if auth is not None and auth_val not in VALID_AUTHORSHIP:
        errors.append(f"authorship must be one of {sorted(VALID_AUTHORSHIP)}, got {auth!r}")

    # Denominator invariant (§2.2 & §3.1): validity buckets must sum to n.trials_planned
    n_block = doc.get("n")
    val_block = doc.get("validity")
    if isinstance(n_block, dict) and isinstance(val_block, dict):
        planned = n_block.get("trials_planned")
        if isinstance(planned, int):
            total = 0
            counted = False
            for b in VALIDITY_BUCKETS:
                v = val_block.get(b)
                if isinstance(v, int):
                    total += v
                    counted = True
                elif isinstance(v, dict) and isinstance(v.get("count"), int):
                    total += v["count"]
                    counted = True
            if counted and total != planned:
                errors.append(
                    f"validity buckets sum to {total}, expected n.trials_planned={planned}"
                )

    return errors


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print("Usage: validate_reporting.py <result.json> [result2.json ...]", file=sys.stderr)
        return 2
    bad = 0
    for raw in argv[1:]:
        p = Path(raw)
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"ERROR {p}: {exc}", file=sys.stderr)
            return 2
        errs = validate_result(doc)
        if errs:
            bad += 1
            print(f"FAIL {p} ({len(errs)} violation(s)):")
            for e in errs:
                print(f"  - {e}")
        else:
            print(f"OK {p} (GBS-REPORTING v0.2 conformant)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
