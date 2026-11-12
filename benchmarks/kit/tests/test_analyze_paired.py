"""Tests for analyze_paired.py.  Run from benchmarks/kit:  python3 -m unittest discover -s tests"""
import argparse
import io
import json
import math
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT))
import analyze_paired as AP  # noqa: E402

EXAMPLE = KIT / "example" / "example.csv"
EXPECTED = KIT / "example" / "expected-output.txt"
EXAMPLE_ARGS = ["--baseline", "baseline", "--aa", "baseline-again:baseline"]


def opts(**kw):
    o = argparse.Namespace(pairs=None, baseline=None, aa=None, margin=0.10, alpha=0.05, seed=AP.DEFAULT_SEED,
                           boot=2000, flips=4000, last_wins=False)
    for k, v in kw.items():
        setattr(o, k, v)
    return o


def rows_from(cells):
    """cells: (task, wave, arm, valid, solved[, share[, usd]])"""
    out = []
    for c in cells:
        task, wave, arm, valid, solved = c[:5]
        share = c[5] if len(c) > 5 else (1.0 if solved else 0.0)
        usd = c[6] if len(c) > 6 else 0.01
        out.append({"task": task, "wave": wave, "arm": arm, "valid": bool(valid), "solved": bool(solved),
                    "hidden_share": share, "usd": usd, "where": "t"})
    return out


def grid(n_tasks, a_solves, b_solves, waves=1):
    """Every task once per wave in arms A and B; a_solves/b_solves(task_index, wave) -> bool."""
    cells = []
    for w in range(waves):
        for t in range(n_tasks):
            wave = f"{w * n_tasks + t + 1:02d}"
            cells.append((f"t{t:02d}", wave, "A", 1, a_solves(t, w)))
            cells.append((f"t{t:02d}", wave, "B", 1, b_solves(t, w)))
    return rows_from(cells)


class ExactTests(unittest.TestCase):
    def test_mcnemar_known_values(self):
        self.assertEqual(AP.mcnemar_exact(0, 0), 1.0)
        self.assertAlmostEqual(AP.mcnemar_exact(5, 0), 2 / 32)
        self.assertAlmostEqual(AP.mcnemar_exact(8, 1), 2 * (1 + 9) / 512)
        self.assertEqual(AP.mcnemar_exact(3, 3), 1.0)
        self.assertEqual(AP.mcnemar_exact(2, 9), AP.mcnemar_exact(9, 2))

    def test_quantile_matches_linear_interpolation(self):
        v = [0.0, 1.0, 2.0, 3.0, 4.0]
        self.assertEqual(AP.quantile(v, 0.5), 2.0)
        self.assertAlmostEqual(AP.quantile(v, 0.025), 0.1)
        self.assertAlmostEqual(AP.quantile(v, 0.975), 3.9)
        self.assertEqual(AP.quantile([1.0, float("inf")], 0.975), float("inf"))

    def test_signflip_exact_all_positive(self):
        sf = AP.SignFlip([0.5] * 5, flips=1000, seed=1)
        self.assertTrue(sf.exact)
        self.assertAlmostEqual(sf.p(0.0), 2 / 32)  # only all-plus and all-minus are as extreme
        sf6 = AP.SignFlip([1.0, 0.5, 0.25, 1.0, 0.75, 0.5], flips=1000, seed=1)
        self.assertAlmostEqual(sf6.p(0.0), 2 / 64)

    def test_signflip_ci_open_when_n_too_small(self):
        lo, hi = AP.SignFlip([0.2, 0.4, 0.1], flips=1000, seed=1).ci(0.05)  # 2/8 > 0.05 at the edge
        self.assertEqual((lo, hi), (float("-inf"), float("inf")))

    def test_signflip_ci_of_constant_differences_is_the_point(self):
        lo, hi = AP.SignFlip([-0.01] * 12, flips=1000, seed=1).ci(0.05)
        self.assertAlmostEqual(lo, -0.01)
        self.assertAlmostEqual(hi, -0.01)

    def test_signflip_ci_contains_mean_and_excludes_far_values(self):
        d = [0.1, 0.3, -0.1, 0.4, 0.2, 0.0, 0.5, 0.3, 0.1, 0.2, 0.6, -0.2]
        lo, hi = AP.SignFlip(d, flips=1000, seed=1).ci(0.05)
        m = sum(d) / len(d)
        self.assertLess(lo, m)
        self.assertGreater(hi, m)
        self.assertGreater(lo, min(d))
        self.assertLess(hi, max(d))

    def test_signflip_monte_carlo_is_seeded(self):
        d = [((i * 37) % 11 - 4) / 10 for i in range(25)]
        a, b = AP.SignFlip(d, 3000, 5), AP.SignFlip(d, 3000, 5)
        self.assertFalse(a.exact)
        self.assertEqual(a.p(), b.p())
        self.assertEqual(a.ci(0.05), b.ci(0.05))

    def test_bootstrap_is_deterministic_and_brackets_the_mean(self):
        d = [0.03, 0.91, 0.47, 0.12, 0.88, 0.95, 0.51, 0.08, 0.27, 0.73, 0.33, 0.61]
        stat = lambda idx: sum(d[i] for i in idx) / len(d)  # noqa: E731
        r1 = AP.bootstrap_ci(len(d), stat, 3000, 0.05, 42)
        r2 = AP.bootstrap_ci(len(d), stat, 3000, 0.05, 42)
        self.assertEqual(r1, r2)
        self.assertLess(r1[0], sum(d) / len(d))
        self.assertGreater(r1[1], sum(d) / len(d))
        self.assertNotEqual(r1, AP.bootstrap_ci(len(d), stat, 3000, 0.05, 43))


class InputTests(unittest.TestCase):
    CSV = "task,wave,arm,valid,solved,hidden_share,usd\nt1,01,A,1,1,1.0,0.02\nt1,01,B,yes,false,0.5,\n"

    def test_csv_and_jsonl_agree(self):
        a = AP.parse_rows(self.CSV, "x.csv")
        jl = "\n".join(json.dumps(x) for x in [
            {"task": "t1", "wave": "01", "arm": "A", "valid": True, "solved": 1, "hidden_share": 1.0, "usd": 0.02},
            {"task": "t1", "wave": "01", "arm": "B", "valid": "yes", "solved": False, "hidden_share": 0.5, "usd": None}])
        b = AP.parse_rows(jl, "x.jsonl")
        strip = lambda rs: [{k: v for k, v in r.items() if k != "where"} for r in rs]  # noqa: E731
        self.assertEqual(strip(a), strip(b))
        self.assertIsNone(a[1]["usd"])

    def test_bad_input_is_refused(self):
        for bad in ("task,wave,arm,valid\nt,1,A,1\n",                              # missing column
                    "task,wave,arm,valid,solved\nt,1,A,maybe,1\n",                 # bad boolean
                    "task,wave,arm,valid,solved,hidden_share\nt,1,A,1,1,1.5\n",    # share out of range
                    "task,wave,arm,valid,solved\nt,r,A,1,1\n",                     # no wave id
                    "task,wave,arm,valid,solved\n"):                               # no rows
            with self.assertRaises(AP.InputError, msg=bad):
                AP.parse_rows(bad, "bad.csv")

    def test_duplicate_cells_refused_unless_last_wins(self):
        rows = rows_from([("t", "01", "A", 1, 0), ("t", "01", "A", 1, 1)])
        with self.assertRaises(AP.InputError):
            AP.dedupe(rows, last_wins=False)
        kept = AP.dedupe(rows, last_wins=True)
        self.assertEqual(len(kept), 1)
        self.assertTrue(kept[0]["solved"])


class RerunTests(unittest.TestCase):
    def test_rerun_replaces_original_for_every_arm(self):
        rows = rows_from([("t", "07", "A", 1, 1), ("t", "07", "B", 0, 0),
                          ("t", "07r", "A", 1, 0), ("t", "07r", "B", 1, 1),
                          ("u", "07", "A", 1, 1), ("u", "07", "B", 1, 0)])  # another task in wave 07: kept
        eff, replaced, warnings = AP.effective(rows)
        self.assertEqual(sorted((r["task"], r["wave"], r["arm"]) for r in eff),
                         [("t", "07r", "A"), ("t", "07r", "B"), ("u", "07", "A"), ("u", "07", "B")])
        self.assertEqual(len(replaced), 2)
        self.assertEqual(warnings, [])

    def test_deepest_rerun_wins(self):
        rows = rows_from([("t", "3", "A", 0, 0), ("t", "3", "B", 1, 1), ("t", "3r", "A", 1, 1),
                          ("t", "3r", "B", 0, 0), ("t", "3rr", "A", 1, 0), ("t", "3rr", "B", 1, 0)])
        eff, replaced, _ = AP.effective(rows)
        self.assertEqual({r["wave"] for r in eff}, {"3rr"})
        self.assertEqual(len(replaced), 4)

    def test_rerun_missing_an_arm_is_warned(self):
        rows = rows_from([("t", "1", "A", 1, 1), ("t", "1", "B", 0, 0), ("t", "1r", "A", 1, 1)])
        _, _, warnings = AP.effective(rows)
        self.assertTrue(any("lacks arm" in w for w in warnings))

    def test_unresolved_invalid_cells_are_warned_and_excluded(self):
        rows = rows_from([("t1", "1", "A", 1, 1), ("t1", "1", "B", 0, 0),
                          ("t2", "2", "A", 1, 1), ("t2", "2", "B", 1, 1)])
        res = AP.analyse(rows, opts(pairs="A:B"))
        self.assertEqual(res["arms"]["B"]["invalid_unresolved"], 1)
        self.assertEqual(res["contrasts"][0]["solved"]["n_tasks"], 1)
        self.assertTrue(any("not yet re-run" in w for w in res["warnings"]))


class VerdictTests(unittest.TestCase):
    def test_clear_win_is_better(self):
        rows = grid(30, lambda t, w: t % 10 != 0, lambda t, w: t % 3 == 0, waves=2)
        c = AP.analyse(rows, opts(pairs="A:B"))["contrasts"][0]
        self.assertEqual(c["solved"]["verdict"], "better")
        self.assertEqual(c["hidden_share"]["verdict"], "better")

    def test_clear_loss_is_worse(self):
        rows = grid(30, lambda t, w: t % 3 == 0, lambda t, w: t % 10 != 0, waves=2)
        c = AP.analyse(rows, opts(pairs="A:B"))["contrasts"][0]
        self.assertEqual(c["solved"]["verdict"], "worse")

    def test_identical_arms_are_never_equal(self):
        rows = grid(20, lambda t, w: t % 2 == 0, lambda t, w: t % 2 == 0, waves=3)
        c = AP.analyse(rows, opts(pairs="A:B"))["contrasts"][0]
        self.assertEqual(c["solved"]["est"], 0.0)
        self.assertEqual(c["solved"]["verdict"], "non-inferior")
        self.assertEqual(AP.analyse(rows, opts(pairs="A:B", margin=None))["contrasts"][0]["solved"]["verdict"],
                         "not shown")
        for c in AP.analyse(rows, opts(pairs="A:B"))["contrasts"]:
            for m in ("solved", "hidden_share", "usd_per_cell", "usd_per_solve"):
                self.assertIn(c[m]["verdict"], AP.VERDICTS)

    def test_small_noisy_difference_is_not_shown(self):
        rows = grid(8, lambda t, w: t < 4, lambda t, w: 2 <= t < 7)
        c = AP.analyse(rows, opts(pairs="A:B"))["contrasts"][0]
        self.assertEqual(c["solved"]["verdict"], "not shown")

    def test_aa_verdict_raises_a_warning(self):
        rows = grid(30, lambda t, w: t % 10 != 0, lambda t, w: t % 3 == 0, waves=2)
        res = AP.analyse(rows, opts(aa="A:B"))
        self.assertTrue(res["contrasts"][0]["aa"])
        self.assertTrue(any("A/A pair" in w for w in res["warnings"]))

    def test_cost_per_solve_ratio(self):
        cells = []
        for t in range(12):
            cells += [(f"t{t}", f"{t}", "A", 1, 1, 1.0, 0.01), (f"t{t}", f"{t}", "B", 1, t % 2 == 0, None, 0.02)]
        c = AP.analyse(rows_from(cells), opts(pairs="A:B"))["contrasts"][0]
        self.assertAlmostEqual(c["usd_per_solve"]["ratio"], (0.12 / 12) / (0.24 / 6))
        self.assertEqual(c["usd_per_solve"]["verdict"], "better")
        self.assertEqual(c["usd_per_cell"]["verdict"], "better")


class ExampleTests(unittest.TestCase):
    def run_main(self, *extra):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = AP.main([str(EXAMPLE), *EXAMPLE_ARGS, *extra])
        return rc, buf.getvalue()

    def test_example_matches_the_published_output(self):
        rc, out = self.run_main()
        self.assertEqual(rc, 0)
        self.assertEqual(out, EXPECTED.read_text(encoding="utf-8"))

    def test_example_is_deterministic_and_json_is_valid(self):
        with tempfile.TemporaryDirectory() as d:
            j1, j2 = Path(d, "1.json"), Path(d, "2.json")
            self.run_main("--json", str(j1))
            self.run_main("--json", str(j2))
            self.assertEqual(j1.read_bytes(), j2.read_bytes())
            res = json.loads(j1.read_text())
        self.assertEqual(res["replaced_rows"], 12)
        cand = next(c for c in res["contrasts"] if c["a"] == "candidate")
        self.assertEqual(cand["solved"]["verdict"], "better")
        aa = next(c for c in res["contrasts"] if c["aa"])
        self.assertNotIn(aa["solved"]["verdict"], ("better", "worse"))

    def test_example_generator_is_reproducible(self):
        sys.path.insert(0, str(KIT / "example"))
        import make_example  # noqa: E402
        buf = io.StringIO()
        make_example.main(buf)
        self.assertEqual(buf.getvalue(), EXAMPLE.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
