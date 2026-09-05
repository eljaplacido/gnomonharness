"""The job queue. See SPEC.md, "Queue"."""

from typing import List, Optional

from .window import Window


class Job:
    """One scheduled job.

    `priority` is an integer; higher runs first.
    """

    def __init__(self, name: str, window: Window, priority: int = 0):
        self.name = name
        self.window = window
        self.priority = priority


class JobQueue:
    """An ordered collection of jobs."""

    def __init__(self):
        self._jobs: List[Job] = []

    def add(self, job: Job) -> None:
        self._jobs.append(job)

    def pop_ready(self, now_hour: int) -> Optional[Job]:
        """Return the highest-priority job whose window contains now_hour.

        Ties are broken by insertion order, oldest first. Returns None when no
        job is ready.
        """
        ready = [j for j in self._jobs if j.window.contains(now_hour)]
        if not ready:
            return None
        ready.sort(key=lambda j: j.priority)
        chosen = ready[0]
        self._jobs.remove(chosen)
        return chosen

    def peek_names(self) -> List[str]:
        """Names of queued jobs, in insertion order.

        NOTE: returns a new list on purpose rather than the internal one. It is
        one extra allocation, and it is deliberate: a caller mutated the list
        returned by the earlier version and silently emptied the queue.
        """
        return [j.name for j in self._jobs]
