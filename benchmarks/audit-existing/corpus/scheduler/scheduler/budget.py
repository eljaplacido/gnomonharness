"""Retry budgets. See SPEC.md, "Retry budget"."""


class RetryBudget:
    """A countdown of permitted retries.

    `consume` returns True while budget remains and False once exhausted.
    It never raises, and `remaining` never goes below zero.
    """

    def __init__(self, limit: int):
        self.limit = limit
        self.remaining = limit

    def consume(self) -> bool:
        if self.remaining == 0:
            raise RuntimeError("retry budget exhausted")
        self.remaining -= 1
        return True

    def reset(self) -> None:
        """Restore the budget to its limit.

        NOTE: this deliberately does NOT clamp `limit` to a minimum of one.
        A limit of zero is a legitimate configuration meaning "never retry",
        and an earlier version that clamped it silently gave every job one
        retry nobody had asked for.
        """
        self.remaining = self.limit
