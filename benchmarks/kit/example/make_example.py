#!/usr/bin/env python3
"""Writes example.csv: a synthetic, seeded benchmark. No real harness or model is behind it.

    python3 make_example.py > example.csv

20 tasks x 3 attempts = 60 waves; every wave runs the same task once in each of three arms:

    baseline         the reference configuration
    baseline-again   the SAME configuration again: an A/A arm, so the noise floor is in the data
    candidate        one changed variable; built to solve more often at a lower cost per cell

Three waves had an invalid cell and were re-run whole ("NNr"); one of those re-runs was itself
invalid and re-run again ("NNrr"). The analysis must use only the deepest re-run.
"""
import csv
import random
import sys

SEED = 7
TASKS = [f"task-{i:02d}" for i in range(1, 21)]
ATTEMPTS = 3
ARMS = ("baseline", "baseline-again", "candidate")
LIFT = {"baseline": 0.0, "baseline-again": 0.0, "candidate": 0.22}
COST = {"baseline": 0.040, "baseline-again": 0.040, "candidate": 0.028}
INVALID = {"07": "candidate", "23": "baseline", "41": "baseline-again"}  # wave -> arm whose cell broke
INVALID_AGAIN = {"23r": "candidate"}  # that re-run broke too


def cell(rng, task_p, arm):
    solved = rng.random() < min(0.97, task_p + LIFT[arm])
    share = 1.0 if solved else round(rng.uniform(0.0, 0.9), 3)
    usd = round(COST[arm] * rng.uniform(0.6, 1.6), 4)
    return solved, share, usd


def main(out=sys.stdout):
    rng = random.Random(SEED)
    difficulty = {t: rng.uniform(0.05, 0.8) for t in TASKS}
    w = csv.writer(out, lineterminator="\n")
    w.writerow(["task", "wave", "arm", "valid", "solved", "hidden_share", "usd"])
    n = 0
    for attempt in range(ATTEMPTS):
        order = TASKS[:]
        random.Random(SEED * 100 + attempt).shuffle(order)
        for task in order:
            n += 1
            wave = f"{n:02d}"
            tries = [wave]
            if wave in INVALID:
                tries.append(wave + "r")
                if wave + "r" in INVALID_AGAIN:
                    tries.append(wave + "rr")
            for wid in tries:
                broken = INVALID.get(wid) or INVALID_AGAIN.get(wid)
                for arm in ARMS:
                    solved, share, usd = cell(rng, difficulty[task], arm)
                    if arm == broken:
                        # An apparatus failure: the verifier never ran. It still cost money.
                        w.writerow([task, wid, arm, 0, 0, "", usd])
                    else:
                        w.writerow([task, wid, arm, 1, int(solved), share, usd])


if __name__ == "__main__":
    main()
