Write `semver.py` providing a comparison for simple semantic versions.

Public API, exactly:
    compare(a: str, b: str) -> int   # -1 if a < b, 0 if equal, 1 if a > b

Versions look like "1.4.2": three dot-separated non-negative integers. Compare
major, then minor, then patch.

Also write `test_semver.py` with unit tests for it.
