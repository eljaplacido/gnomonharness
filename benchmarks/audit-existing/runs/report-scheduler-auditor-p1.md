Here is the full defect report:

---

### Defect 1 — `scheduler/window.py:11-15`
**What is wrong:** `Window.__init__` never validates that `end_hour > start_hour`, nor does it validate `end_hour`'s range.
**Intended behaviour:** The SPEC says "A window whose end is not after its start is invalid and must raise `ValueError` at construction." The docstring says "Raises ValueError when end_hour is not after start_hour."

### Defect 2 — `scheduler/window.py:19`
**What is wrong:** `Window.contains` uses `<=` for the upper bound: `self.start_hour <= hour <= self.end_hour`. This includes `end_hour` in the window.
**Intended behaviour:** The SPEC defines a half-open interval `[start, end)` — "a job may run at `start_hour` and may not run at `end_hour`." The docstring agrees. The comparison should be `self.start_hour <= hour < self.end_hour`.

### Defect 3 — `scheduler/budget.py:16-17`
**What is wrong:** `RetryBudget.consume` raises `RuntimeError("retry budget exhausted")` when `remaining == 0`.
**Intended behaviour:** The SPEC says "`consume()` returns True while budget remains and False once it is exhausted. It never raises." The docstring says "It never raises." The method should return `False` instead of raising.

### Defect 4 — `scheduler/queue.py:38`
**What is wrong:** `JobQueue.pop_ready` sorts by `j.priority` in ascending order and picks `ready[0]`, which is the *lowest*-priority job.
**Intended behaviour:** The SPEC says "Higher `priority` wins." The docstring says "Return the highest-priority job." The sort should be descending (e.g. `reverse=True`) so the highest-priority job is first.

### Defect 5 — `scheduler/runner.py:21`
**What is wrong:** The range check is `now_hour < 0 or now_hour > 24`, which allows values 24 and 25 through.
**Intended behaviour:** The SPEC says "now_hour is in 0-23." The docstring says the same. The check should be `now_hour < 0 or now_hour > 23`.

### Defect 6 — `scheduler/runner.py:19`
**What is wrong:** `queue.pop_ready(now_hour)` is called on line 19, *before* the `now_hour` validation on line 21. If `now_hour` is out of range, a job has already been popped from the queue.
**Intended behaviour:** The SPEC says "Both are preconditions, checked before any job is touched." The docstring says "Preconditions, both checked before any job is touched." Validation must precede any queue access.

### Defect 7 — `scheduler/runner.py:24-27`
**What is wrong:** `execute(job.name)` on line 25 is not wrapped in a try/except. If `execute` raises, the exception propagates and the loop stops.
**Intended behaviour:** The SPEC says "Jobs that raise are recorded as failed and must not stop the remaining jobs." The docstring says "A job that raises is recorded as 'failed' and does not stop the remaining jobs." Each job execution should be in a try/except; on exception the result should be recorded as `"failed"` and the loop should continue.