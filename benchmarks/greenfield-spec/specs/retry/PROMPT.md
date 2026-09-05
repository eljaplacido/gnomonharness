Write `retry.py` providing a backoff schedule generator.

Public API, exactly:
    delays(attempts: int, base_ms: int, cap_ms: int) -> list[int]

Return the delay before each retry, doubling from base_ms, never exceeding
cap_ms. `attempts` is the number of retries.

Also write `test_retry.py` with unit tests for it.
