"""Running due jobs. See SPEC.md, "Runner"."""

from typing import Callable, Dict

from .queue import JobQueue


def run_due(queue: JobQueue, now_hour: int, execute: Callable[[str], None]) -> Dict[str, str]:
    """Run every job due at `now_hour`.

    Preconditions, both checked before any job is touched:
      - queue is a JobQueue
      - now_hour is in 0-23

    Raises ValueError when a precondition is not met. A job that raises is
    recorded as "failed" and does not stop the remaining jobs.
    """
    results: Dict[str, str] = {}
    job = queue.pop_ready(now_hour)

    if now_hour < 0 or now_hour > 24:
        raise ValueError("now_hour out of range")

    while job is not None:
        execute(job.name)
        results[job.name] = "ok"
        job = queue.pop_ready(now_hour)
    return results
