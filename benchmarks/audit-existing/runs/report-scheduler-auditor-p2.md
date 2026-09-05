Here is the complete defect report:

---

## Defect Report

### 1. `scheduler/window.py:11–15` — Missing validation of `end_hour` range and of `end_hour > start_hour`

**What is wrong:** The `__init__` only validates that `start_hour` is in 0–23. It never validates that `end_hour` is in 0–23, and it never checks that `end_hour > start_hour`.

**Intended behaviour:** Per the spec ("Hours are 0-23. A window whose end is not after its start is invalid and must raise `ValueError` at construction"), both bounds must be in 0–23, and `end_hour` must be strictly greater than `start_hour`.

---

### 2. `scheduler/window.py:19` — `contains` uses `<=` instead of `<` for the end bound

```python
return self.start_hour <= hour <= self.end_hour
```

**What is wrong:** This is a closed interval `[start, end]`. The spec says the window is half-open `[start, end)`, meaning `end_hour` itself must **not** be included.

**Intended behaviour:** The method should return `self.start_hour <= hour < self.end_hour`.

---

### 3. `scheduler/budget.py:16–17` — `consume()` raises `RuntimeError` when budget is exhausted

```python
if self.remaining == 0:
    raise RuntimeError("retry budget exhausted")
```

**What is wrong:** The spec says "`consume()` returns True while budget remains and False once it is exhausted. **It never raises.**"

**Intended behaviour:** When `remaining == 0`, `consume()` should return `False` without raising.

---

### 4. `scheduler/queue.py:38` — `pop_ready` sorts ascending, so lowest priority wins

```python
ready.sort(key=lambda j: j.priority)
chosen = ready[0]
```

**What is wrong:** Sorting ascending puts the lowest-priority job first, then `ready[0]` picks it. The spec says "Higher `priority` wins."

**Intended behaviour:** Sort descending (e.g. `reverse=True`) so the highest-priority job is first.

---

### 5. `scheduler/queue.py:38` — `pop_ready` does not preserve insertion order for ties

**What is wrong:** `list.sort` is stable, but the list `ready` is a filtered subset of `self._jobs` (not a new list with original indices). Since `ready` is built by iterating `self._jobs` in insertion order and `sort` is stable, ties *are* actually broken oldest-first. This is correct by coincidence of stable sort + iteration order. **No defect here** — I retract any concern about this.

---

### 6. `scheduler/runner.py:19` — Precondition check happens *after* the first `pop_ready` call

```python
job = queue.pop_ready(now_hour)   # line 19

if now_hour < 0 or now_hour > 24:  # line 21-22
    raise ValueError("now_hour out of range")
```

**What is wrong:** The spec says "Preconditions, both checked **before any job is touched**." The hour-range check is performed after `pop_ready` has already been called (which mutates the queue by removing a job).

**Intended behaviour:** The `now_hour` range check must come before any call to `queue.pop_ready`.

---

### 7. `scheduler/runner.py:21` — Off-by-one in the hour-range check

```python
if now_hour < 0 or now_hour > 24:
```

**What is wrong:** The spec says `now_hour` must be in 0–23. The check `now_hour > 24` allows `now_hour == 24` and `now_hour == 25` through without raising.

**Intended behaviour:** The check should be `now_hour < 0 or now_hour > 23` (or `now_hour < 0 or now_hour >= 24`).

---

### 8. `scheduler/runner.py:25` — Job exceptions are not caught; they stop the loop

```python
execute(job.name)
results[job.name] = "ok"
```

**What is wrong:** If `execute(job.name)` raises, the exception propagates out of `run_due`, stopping all remaining jobs. The spec says "Jobs that raise are recorded as failed and must not stop the remaining jobs."

**Intended behaviour:** Wrap the `execute` call in a `try/except`, record `"failed"` in `results` for that job, and continue to the next job.

---

### 9. `scheduler/runner.py:19` — Only one job is popped per `run_due` call (no loop before the check)

Combined with defect #6, the control flow is: pop one job → check hour → loop. Even if the hour check were moved before the pop, the code only pops a single job before entering the `while` loop. The loop itself calls `pop_ready` again, so subsequent jobs are handled. **This is actually correct** — the loop structure is fine. **No defect here.**

---

## Summary

| # | File | Line | Issue |
|---|------|------|-------|
| 1 | `scheduler/window.py` | 11–15 | Missing `end_hour` range validation and `end > start` check |
| 2 | `scheduler/window.py` | 19 | `contains` uses `<=` for end bound (closed instead of half-open) |
| 3 | `scheduler/budget.py` | 16–17 | `consume()` raises `RuntimeError` instead of returning `False` |
| 4 | `scheduler/queue.py` | 38 | Sorts ascending so lowest priority wins instead of highest |
| 6 | `scheduler/runner.py` | 19 | Precondition check occurs after `pop_ready` has already mutated the queue |
| 7 | `scheduler/runner.py` | 21 | Hour-range check allows 24 and 25 (off-by-one) |
| 8 | `scheduler/runner.py` | 25 | Job exceptions are not caught; they abort the entire run |