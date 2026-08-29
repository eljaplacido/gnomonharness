#!/usr/bin/env python3
"""Analyze the DFlash on/off sweep: per-task wall-clock, tok/s, valid-trial
pass, and the projected timeout-flip at a range of caps.

Because the arms are greedy (temp 0) and speculative decoding is output-exact,
the answers are held constant across on/off — so a wall-clock delta is the
whole story, and any pass difference is timeout-driven.
"""
import json, statistics as st
from pathlib import Path

HERE = Path(__file__).parent
CAPS = [60, 120, 180, 300, 600, 900]


def load(arm):
    p = HERE / "results" / f"{arm}.jsonl"
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(st.median(xs), 2) if xs else None


def main():
    on, off = load("dflash-on"), load("dflash-off")
    if not on or not off:
        print("missing arm data (on=%d off=%d)" % (len(on), len(off)))
        return
    tasks = sorted({r["task"] for r in on} | {r["task"] for r in off})

    print("\n================ DFlash on/off — per-task wall-clock ================")
    print(f"{'task':<12} {'on_wall':>8} {'off_wall':>8} {'speedup':>8} "
          f"{'on_toks':>7} {'on_t/s':>7} {'off_t/s':>7} {'pass on/off':>12}")
    tot_on = tot_off = 0.0
    for t in tasks:
        o = [r for r in on if r["task"] == t]
        f = [r for r in off if r["task"] == t]
        onw, offw = med([r["wall_s"] for r in o]), med([r["wall_s"] for r in f])
        sp = round(offw / onw, 2) if onw and offw else None
        if onw and offw:
            tot_on += onw
            tot_off += offw
        onts, offts = med([r["tok_s"] for r in o]), med([r["tok_s"] for r in f])
        ontok = med([r["tokens_out"] for r in o])
        pon = sum(1 for r in o if r["passed"])
        poff = sum(1 for r in f if r["passed"])
        print(f"{t:<12} {str(onw):>8} {str(offw):>8} {str(sp)+'x':>8} "
              f"{str(ontok):>7} {str(onts):>7} {str(offts):>7} {f'{pon}/{len(o)} {poff}/{len(f)}':>12}")

    print("-" * 70)
    agg = round(tot_off / tot_on, 2) if tot_on else None
    print(f"{'TOTAL':<12} {round(tot_on,1):>8} {round(tot_off,1):>8} {str(agg)+'x':>8}"
          "   (sum of per-task medians)")

    # decode-rate summary
    on_ts = [r["tok_s"] for r in on if r["tok_s"]]
    off_ts = [r["tok_s"] for r in off if r["tok_s"]]
    print(f"\nEnd-to-end tok/s (median over all trials): on={med(on_ts)}  off={med(off_ts)}  "
          f"ratio={round(med(on_ts)/med(off_ts),2) if med(off_ts) else '?'}x")

    # valid-trial pass (three-bucket)
    def bucketstat(rows):
        n = len(rows)
        crash = sum(1 for r in rows if r["bucket"] not in ("result", "refusal") and r["status"] != "timeout" or r["bucket"] == "apparatus_failure")
        to = sum(1 for r in rows if r["status"] == "timeout")
        ok = sum(1 for r in rows if r["passed"])
        valid = n - crash
        return n, ok, to, crash, (round(100 * ok / valid, 1) if valid else 0)
    print("\nValid-trial pass (pass / (n - crash)):")
    for label, rows in (("on", on), ("off", off)):
        n, ok, to, cr, pct = bucketstat(rows)
        print(f"  {label:<4} n={n} pass={ok} timeout={to} crash={cr} -> {pct}% valid-pass")

    # projected timeout-flip: at each cap, how many trial-runs cross off>cap>=on
    print("\nProjected timeout-flip (off exceeds cap, on does not) per cap, "
          "matched by task+trial where possible:")
    # pair by (task, trial)
    idx = {(r["task"], r["trial"]): r for r in on}
    pairs = [(idx.get((r["task"], r["trial"])), r) for r in off if (r["task"], r["trial"]) in idx]
    for cap in CAPS:
        flips = sum(1 for o, f in pairs if o and o["wall_s"] <= cap < f["wall_s"])
        both_over = sum(1 for o, f in pairs if o and o["wall_s"] > cap and f["wall_s"] > cap)
        print(f"  cap {cap:>4}s: {flips} flip(s) off->on, {both_over} still-timeout on both  (of {len(pairs)} paired runs)")

    print("\nNote: greedy (temp 0) + output-exact spec-decode, so pass/fail is held")
    print("constant across arms and wall-clock is the sole variable. Prompt-cache")
    print("warms equally on both arms, so the on/off ratio is unaffected by it.")


if __name__ == "__main__":
    main()
