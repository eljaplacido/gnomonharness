"""AS1 sizing with the causal platform's paired designs (causal-decision PR #107, merged 2026-11-04 as 46a8b30; its head
631a762 is checked out at ~/causal-wt/decision-gaps). Writes ../SIZING.txt.

    ~/causal-wt/decision-gaps/backend/.venv/bin/python sizing_as1.py

Continuous outcome (hidden-test fraction): causal_decision.policy._paired_pairs sizes a matched-pair trial on the
within-pair SD (t(K-1) iterated). Binary outcome (solved): causal_core.blocked.paired_binary_pairs, exact against the
kernel's McNemar-consistent interval. Inputs (stated, from finished campaigns only; H3 is still running and unused):
- per-cell noise of the fraction: an A/A pair of the same configuration has SD 0.06-0.12 when no cell flips (H1/H2 B
  vs P2G41 B41, n = 6-11) and 0.39 for a near-null concurrent arm with two flips in 11 (H2 C vs B). AS1 assumes a pair
  SD of 0.25 from noise alone (2 sigma_n^2 = 0.0625), between the two;
- between-arm heterogeneity of the per-task effect: C* vs its own control, small (variance 0.02, SD 0.14); C* vs
  opencode, as P2G41 B41 vs O measured (pair SD 0.413 at k = 1 -> heterogeneity variance 0.413^2 - 0.0625 = 0.108);
- solved: P2G41 B41 vs O had 5 discordant pairs of 25 (0.20).
"""
import math
from pathlib import Path

from scipy import stats

OUT = Path(__file__).resolve().parent.parent / "SIZING.txt"
NOISE2 = 0.0625          # 2 sigma_n^2: a k = 1 pair's variance from cell noise alone
HET = {"C* vs CTL": 0.02, "C* vs O": 0.413 ** 2 - 0.0625}
N_TASKS, K = 29, 3
MARGIN, ALPHA, POWER = 0.10, 0.05, 0.80

try:
    from causal_decision.contract import DecisionPolicy, PairedEvidence
    from causal_decision.policy import _paired_pairs
    from causal_core.blocked import paired_binary_pairs, paired_binary_power
    import causal_decision
    SRC = f"causal_decision {Path(causal_decision.__file__).parent} (PR #107 head)"
except Exception as e:  # the same formulas, so the file can still be produced; says which ran
    SRC = f"FALLBACK formulas (causal platform not importable: {type(e).__name__})"
    DecisionPolicy = PairedEvidence = None


def pairs_needed(sd: float, mde: float) -> int:
    if PairedEvidence is not None:
        return _paired_pairs(PairedEvidence(n_pairs=N_TASKS, binary_outcome=False, sd_difference=sd), mde,
                             DecisionPolicy())[0]
    k = 2
    for _ in range(50):
        nxt = max(math.ceil(((stats.t.ppf(1 - ALPHA / 2, k - 1) + stats.t.ppf(POWER, k - 1)) * sd / mde) ** 2), 2)
        if nxt == k:
            break
        k = nxt
    return k


def ni_power(sd: float, n: int, delta: float, margin: float = MARGIN) -> float:
    """P(the 95% interval's lower bound of the paired mean difference > -margin) when the true difference is delta."""
    se = sd / math.sqrt(n)
    t = stats.t.ppf(1 - ALPHA / 2, n - 1)
    return float(stats.norm.sf((-margin + t * se - delta) / se))


def sup_power(sd: float, n: int, delta: float) -> float:
    se = sd / math.sqrt(n)
    t = stats.t.ppf(1 - ALPHA / 2, n - 1)
    return float(stats.norm.sf((t * se - delta) / se))


def main():
    L = [f"AS1 sizing ({SRC}). alpha {ALPHA} two-sided, power {POWER}. See the docstring of sizing_as1.py for inputs."]
    L.append("\nConfirmatory stage: 29 tasks, attempt-averaged per task, k = 3 (and k = 2 under the lean budget).")
    for k in (3, 2, 1):
        for name, het in HET.items():
            sd = math.sqrt(het + NOISE2 / k)
            n10 = pairs_needed(sd, 0.10)
            L.append(f"  k={k} {name:10s} per-task SD of d {sd:.3f}: tasks needed for a 0.10 difference at 80% "
                     f"power {n10}; at n = 29: MDE80 {(stats.t.ppf(.975, 28) + stats.t.ppf(.8, 28)) * sd / math.sqrt(29):.3f}, "
                     f"power for +0.10 {sup_power(sd, 29, 0.10):.2f}, "
                     f"P(non-inferiority at 10 pts shown | true 0) {ni_power(sd, 29, 0.0):.2f}, "
                     f"| true +0.05 {ni_power(sd, 29, 0.05):.2f}")
    L.append("\nSolved (binary), C* vs O at k = 1 pairs (P2G41 discordance 0.20):")
    for eff in (0.10, 0.15, 0.20):
        if PairedEvidence is not None:
            n = paired_binary_pairs(max(0.20, eff), eff, ALPHA, POWER)
            L.append(f"  a {eff:.2f} difference in solve rate needs {n} task pairs (exact, causal_core.blocked)")
    if PairedEvidence is not None:
        pb, ph = 0.15, 0.05
        L.append(f"  at 87 cell pairs (29 x 3, treated as pairs for McNemar) with 15% vs 5% one-sided discordance: "
                 f"power {paired_binary_power(87, pb, ph, ALPHA):.2f} (ignores clustering within task: optimistic)")
    L.append("\nScreening: per arm, paired cells against the wave's control (pair SD ~0.22 in the simulation, 0.25 assumed):")
    for n in (4, 8, 12):
        mde = (stats.t.ppf(.975, n - 1) + stats.t.ppf(.8, n - 1)) * 0.25 / math.sqrt(n)
        L.append(f"  n = {n:2d}: classical two-sided MDE80 {mde:.2f}; the Bayesian rule (P(Delta>0) >= 0.90, one-sided, "
                 f"shrunk) is more lenient and is calibrated by simulation instead (ALLOCATION-SIM.txt)")
    L.append("\nReading: k = 3 on 29 tasks resolves about a 0.11 improvement over the control (80%) and shows "
             "10-point non-inferiority to opencode with ~0.3 probability at true parity, ~0.6 at +0.05 (opencode's "
             "per-task heterogeneity dominates; more attempts barely help). The confirmatory stage can therefore "
             "support 'C* beats its control' if the effect is >= ~0.11, and is low-powered for parity with opencode: "
             "a 'not shown' there is expected and is not 'trails'.")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L))


if __name__ == "__main__":
    main()
