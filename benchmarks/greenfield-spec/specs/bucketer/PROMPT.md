Write `bucketer.py` providing a `bucket` function that labels an order total.

Public API, exactly:
    bucket(total: float) -> str

Totals under 50 are "small", 50 up to 200 are "medium", and 200 and above are
"large".

Also write `test_bucketer.py` with unit tests for it.
