# Scheduler — specification

A small job scheduler.

## Windows

`Window(start_hour, end_hour)` is a half-open interval [start, end): a job may
run at `start_hour` and may not run at `end_hour`. Hours are 0-23. A window whose
end is not after its start is invalid and must raise `ValueError` at construction.

## Retry budget

`RetryBudget.consume()` returns True while budget remains and False once it is
exhausted. It never raises. `remaining` never goes below zero.

## Queue

`JobQueue.pop_ready(now_hour)` returns the highest-priority job whose window
contains `now_hour`, or `None` when there is none. Higher `priority` wins; ties
are broken by insertion order, oldest first.

## Runner

`run_due` requires a queue and an hour in 0-23. Both are preconditions, checked
before any job is touched. An out-of-range hour raises `ValueError`.
Jobs that raise are recorded as failed and must not stop the remaining jobs.
