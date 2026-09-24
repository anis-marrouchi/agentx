"""Tests for report.py. Standard library only:

    python3 -m unittest discover -s bench/harbor -p "test_*.py"
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import report  # noqa: E402


def write_trial(root: Path, job: str, trial: str, task: str, reward, tokens, cost, secs=60):
    d = root / job / trial
    d.mkdir(parents=True)
    (root / job / "result.json").write_text(json.dumps({"id": job}))
    (d / "result.json").write_text(json.dumps({
        "trial_name": trial,
        "task_name": task,
        "config": {"agent": {"name": job, "model_name": "anthropic/m", "kwargs": {}}},
        "agent_info": {"name": job, "version": "1"},
        "agent_result": {} if tokens is None else {
            "n_input_tokens": tokens, "n_cache_tokens": 0, "n_output_tokens": 0, "cost_usd": cost},
        "verifier_result": None if reward is None else {"rewards": {"reward": reward}},
        "agent_execution": {"started_at": "2026-01-01T00:00:00+00:00",
                            "finished_at": f"2026-01-01T00:{secs // 60:02d}:{secs % 60:02d}+00:00"},
    }))


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_summary_counts_unsolved_and_skips_missing_tokens(self):
        write_trial(self.root, "a", "t1", "x", 1, 1000, 1.0)
        write_trial(self.root, "a", "t2", "y", None, None, None)  # killed: no verdict, no usage
        [row] = report.summarize(report.load([self.root]))
        self.assertEqual((row["trials"], row["solved"]), (2, 1))
        self.assertEqual(row["input_tokens_mean"], 1000)  # the missing trial is not a zero
        self.assertEqual(row["unpriced"], 1)

    def test_compare_pairs_on_tasks_both_solved(self):
        # B costs half as much on every task both solve.
        for i, task in enumerate(["p", "q", "r", "s"]):
            write_trial(self.root, "base", f"a{i}", task, 1, 1000, 1.0 + i)
            write_trial(self.root, "cand", f"b{i}", task, 1, 500, (1.0 + i) / 2)
        # A task only A solves is excluded from the ratio but counted in pass.
        write_trial(self.root, "base", "a9", "only-a", 1, 1000, 9.0)
        write_trial(self.root, "cand", "b9", "only-a", 0, 99999, 99.0)
        c = report.compare(report.load([self.root]), "base", "cand")
        self.assertEqual(c["both"], ["p", "q", "r", "s"])
        mid, lo, hi = c["ratios"]["cost"]
        self.assertAlmostEqual(mid, 0.5)
        self.assertAlmostEqual(lo, 0.5)
        self.assertAlmostEqual(hi, 0.5)
        self.assertEqual((c["a_solved"], c["b_solved"]), (5, 4))
        self.assertFalse(c["regression"])

    def test_compare_flags_a_pass_regression(self):
        for i, task in enumerate(["p", "q", "r"]):
            write_trial(self.root, "base", f"a{i}", task, 1, 1000, 1.0)
            write_trial(self.root, "cand", f"b{i}", task, 1 if task == "p" else 0, 100, 0.1)
        c = report.compare(report.load([self.root]), "base", "cand")
        self.assertTrue(c["regression"])

    def test_bootstrap_interval_straddles_one_for_mixed_results(self):
        mid, lo, hi = report.geomean_ratio([(1, 0.5), (1, 2.0), (1, 0.8), (1, 1.25)])
        self.assertAlmostEqual(mid, 1.0)
        self.assertLess(lo, 1.0)
        self.assertGreater(hi, 1.0)


if __name__ == "__main__":
    unittest.main()
