"""Boundary cases for the standalone concurrency report generator."""

import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "agentic_sweep",
    Path(__file__).resolve().parents[1] / "scripts/sweep_agentic_concurrency.py",
)
assert spec is not None and spec.loader is not None
sweep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sweep)


def success(c, gpus, ttft=733.961, tpot=48.386, supported=None):
    return {
        "request": sweep.payload(c),
        "url": sweep.URL,
        "http_status": 200,
        "response": {
            "status": "completed",
            "requestId": "size_test",
            "mode": "agg",
            "recommendation": {
                "gpusNeeded": gpus,
                "gpusPerReplica": gpus,
                "replicasNeeded": 1,
                "batchSize": 28,
            },
            "performance": {
                "ttftLatencyMs": ttft,
                "tpotMs": tpot,
                "concurrency": supported if supported is not None else max(c, 28),
            },
            "memory": {"value": 68.432},
        },
    }


class SweepTest(unittest.TestCase):
    def test_user_example_maps_to_one_gpu_and_preserves_reported_concurrency(self):
        rows, budgets = sweep.summarize({1: success(1, 1)}, end=16)
        self.assertEqual(rows[0]["gpus_required"], 1)
        self.assertEqual(rows[0]["ttft_ms"], 733.961)
        self.assertEqual(rows[0]["reported_concurrency"], 28)
        self.assertEqual(budgets[0]["max_tested_concurrency"], 1)
        self.assertEqual(budgets[0]["reported_concurrency"], 28)

    def test_reverse_mapping_has_gaps_and_uses_highest_target(self):
        records = {1: success(1, 6), 2: success(2, 8), 3: success(3, 6)}
        rows, budgets = sweep.summarize(records)
        self.assertEqual(rows[0]["status"], "feasible")
        self.assertEqual(budgets[0]["max_tested_concurrency"], "")
        self.assertEqual(budgets[5]["max_tested_concurrency"], 3)
        self.assertEqual(budgets[7]["max_tested_concurrency"], 3)
        self.assertEqual(budgets[7]["gpus_required"], 6)

    def test_budget_preserves_selected_replica_topology(self):
        record = success(14, 6)
        record["response"]["recommendation"].update(replicasNeeded=3, gpusPerReplica=2)
        _, budgets = sweep.summarize({14: record}, end=16)
        self.assertEqual(budgets[5]["replicas"], 3)
        self.assertEqual(budgets[5]["gpus_per_replica"], 2)

    def test_latency_gpu_bound_and_errors_are_not_feasible(self):
        records = {
            1: success(1, 9),
            2: success(2, 8, ttft=3001),
            3: success(3, 8, tpot=51),
            4: {
                "request": sweep.payload(4),
                "http_status": 422,
                "response": {
                    "status": "failed",
                    "error": {"code": "AISIM_NO_CONFIGURATION"},
                },
            },
            5: {
                "request": sweep.payload(5),
                "http_status": 500,
                "response": {"detail": "failure"},
            },
        }
        rows, budgets = sweep.summarize(records)
        self.assertEqual(
            [r["status"] for r in rows[:6]],
            ["feasible", "error", "error", "infeasible", "error", "missing"],
        )
        self.assertTrue(all(not r["max_tested_concurrency"] for r in budgets))

    def test_insufficient_reported_concurrency_is_not_feasible(self):
        rows, _ = sweep.summarize({16: success(16, 1, supported=15)}, end=16)
        self.assertEqual(rows[15]["status"], "error")

    def test_sweep_limit_is_not_a_claimed_maximum(self):
        _, budgets = sweep.summarize({256: success(256, 8)})
        self.assertEqual(budgets[7]["status"], "at least 256; sweep capped")

    def test_partial_sweep_ignores_out_of_scope_records(self):
        rows, budgets = sweep.summarize(
            {16: success(16, 8), 17: success(17, 6)}, end=16
        )
        self.assertEqual(len(rows), 16)
        self.assertEqual(budgets[7]["max_tested_concurrency"], 16)
        self.assertEqual(budgets[7]["status"], "at least 16; sweep capped")
        self.assertEqual(budgets[5]["max_tested_concurrency"], "")

    def test_adjacent_target_checks_sparse_budget_boundary(self):
        rows, budgets = sweep.summarize(
            {28: success(28, 1), 29: success(29, 2), 256: success(256, 8)}, end=256
        )
        self.assertEqual(rows[27]["gpus_required"], 1)
        self.assertEqual(budgets[0]["max_tested_concurrency"], 28)
        self.assertEqual(
            budgets[0]["status"], "adjacent boundary checked; monotonicity assumed"
        )
        self.assertEqual(
            budgets[1]["status"], "lower bound; next target untested or unresolved"
        )
        self.assertEqual(budgets[7]["status"], "at least 256; sweep capped")


if __name__ == "__main__":
    unittest.main()
