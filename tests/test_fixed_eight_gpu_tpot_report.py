"""Sanity-check the reproducible eight-GPU TPOT evidence."""

import csv
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


REPORT = (
    Path(__file__).resolve().parents[1]
    / "docs/agentic-concurrency-sweep/configiq-local"
)


class FixedEightGpuReportTest(unittest.TestCase):
    def test_tpot_boundary_and_recommendation_calibration(self):
        with (REPORT / "fixed_eight_gpu_tpot.csv").open(newline="") as file:
            rows = list(csv.DictReader(file))
        by_batch = {int(row["batch_per_replica"]): row for row in rows}
        self.assertEqual(len(rows), 9)
        self.assertEqual(int(by_batch[64]["four_replica_capacity"]), 256)
        self.assertEqual(by_batch[64]["meets_tpot"], "True")
        self.assertEqual(by_batch[65]["meets_tpot"], "False")
        self.assertAlmostEqual(float(by_batch[64]["ttft_ms"]), 678.991, places=2)
        self.assertAlmostEqual(float(by_batch[64]["tpot_ms"]), 49.903, places=2)
        self.assertGreater(float(by_batch[65]["tpot_ms"]), 50)
        self.assertTrue(
            all(
                float(a["tpot_ms"]) < float(b["tpot_ms"])
                for a, b in zip(rows, rows[1:])
            )
        )

    def test_graph_and_report_are_well_formed(self):
        root = ET.parse(REPORT / "fixed_eight_gpu_tpot.svg").getroot()
        self.assertEqual(root.tag, "{http://www.w3.org/2000/svg}svg")
        text = (REPORT / "README.md").read_text()
        self.assertIn("fixed_eight_gpu_tpot.svg", text)
        self.assertIn("257 changes to 10 GPUs", text)


if __name__ == "__main__":
    unittest.main()
