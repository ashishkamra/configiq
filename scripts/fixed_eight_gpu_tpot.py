"""Estimate cached-prefix TPOT on a fixed 4 × (2-GPU) vLLM deployment.

Run with the repo service's installed SDK:
  services/aisimulators/.venv/bin/python3 scripts/fixed_eight_gpu_tpot.py

The REST /estimate endpoint does not expose prefix; cli_estimate does.
"""

import csv
from pathlib import Path

from aiconfigurator.cli.api import cli_estimate


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs/agentic-concurrency-sweep/configiq-local"
MODEL = "nvidia/Qwen3.6-27B-NVFP4"
SYSTEM = "rtx_pro_6000_server"
REPLICAS = 4
GPUS_PER_REPLICA = 2
BATCHES = (56, 60, 62, 63, 64, 65, 66, 68, 72)
FIELDS = (
    "batch_per_replica",
    "four_replica_capacity",
    "ttft_ms",
    "tpot_ms",
    "tpot_headroom_ms",
    "memory_gb_per_gpu",
    "meets_ttft",
    "meets_tpot",
)


def estimate(batch):
    result = cli_estimate(
        MODEL,
        system_name=SYSTEM,
        backend_name="vllm",
        database_mode="HYBRID",
        isl=32768,
        osl=2048,
        prefix=30000,
        tp_size=2,
        pp_size=1,
        batch_size=batch,
        gemm_quant_mode="fp8_static",
        kvcache_quant_mode="fp8",
        fmha_quant_mode="bfloat16",
    )
    return {
        "batch_per_replica": batch,
        "four_replica_capacity": batch * REPLICAS,
        "ttft_ms": result.ttft,
        "tpot_ms": result.tpot,
        "tpot_headroom_ms": 50 - result.tpot,
        "memory_gb_per_gpu": result.raw.get("memory"),
        "meets_ttft": result.ttft <= 3000,
        "meets_tpot": result.tpot <= 50,
    }


def write_graph(rows):
    x = lambda load: 90 + (load - 224) * 10.5
    y = lambda tpot: 360 - (tpot - 44) * 17
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="850" height="440" viewBox="0 0 850 440">',
        '<rect width="100%" height="100%" fill="white"/>',
        '<g font-family="sans-serif" fill="#151515">',
        '<text x="65" y="28" font-size="19">Fixed 8 GPUs: TPOT rises with concurrent turns</text>',
        '<text x="65" y="52" font-size="13">4 replicas × 2 GPUs · 30,000 cached-prefix tokens · TTFT &lt; 3 s</text>',
        '<path d="M90 122 V360 H762" fill="none" stroke="#3c3f42" stroke-width="2"/>',
    ]
    for tick in (44, 46, 48, 50, 52, 54, 56, 58):
        py = y(tick)
        parts.append(f'<path d="M90 {py} H762" stroke="#ddd"/>')
        parts.append(
            f'<text x="77" y="{py + 4}" text-anchor="end" font-size="12">{tick}</text>'
        )
    limit = y(50)
    parts.append(
        f'<path d="M90 {limit} H762" stroke="#54585c" stroke-width="2" stroke-dasharray="6 5"/>'
    )
    parts.append(
        f'<text x="630" y="{limit - 8}" font-size="13">50 ms TPOT limit</text>'
    )
    for load in (224, 240, 256, 272, 288):
        parts.append(
            f'<text x="{x(load):.1f}" y="385" text-anchor="middle" font-size="13">{load}</text>'
        )
    parts.append(
        '<text x="425" y="418" text-anchor="middle" font-size="14">Concurrent inference turns (4 × batch size)</text>'
    )
    parts.append(
        '<text transform="translate(23 242) rotate(-90)" text-anchor="middle" font-size="14">Predicted TPOT (ms)</text>'
    )
    points = " ".join(
        f"{x(row['four_replica_capacity']):.1f},{y(row['tpot_ms']):.1f}" for row in rows
    )
    parts.append(
        f'<polyline points="{points}" fill="none" stroke="#0066cc" stroke-width="2"/>'
    )
    for row in rows:
        px, py = x(row["four_replica_capacity"]), y(row["tpot_ms"])
        fill = "#0066cc" if row["meets_tpot"] else "#9b5600"
        parts.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="5" fill="{fill}"/>')
        if row["batch_per_replica"] in (64, 65):
            shift = -12 if row["batch_per_replica"] == 64 else 22
            parts.append(
                f'<text x="{px:.1f}" y="{py + shift:.1f}" font-size="12" text-anchor="middle">{row["tpot_ms"]:.2f}</text>'
            )
    parts.append("</g></svg>")
    (OUTPUT / "fixed_eight_gpu_tpot.svg").write_text("\n".join(parts) + "\n")


def main():
    rows = [estimate(batch) for batch in BATCHES]
    calibrated = next(row for row in rows if row["batch_per_replica"] == 64)
    if not (
        abs(calibrated["ttft_ms"] - 678.991) < 0.01
        and abs(calibrated["tpot_ms"] - 49.903) < 0.01
    ):
        raise RuntimeError(
            "Fixed-topology estimate disagrees with the 256-target recommendation"
        )
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with (OUTPUT / "fixed_eight_gpu_tpot.csv").open("w", newline="") as file:
        fields: list[str] = list(FIELDS)
        writer = csv.DictWriter(file, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    write_graph(rows)
    for row in rows:
        print(
            f"{row['four_replica_capacity']:>3} turns ({row['batch_per_replica']:>2}/replica): "
            f"TTFT={row['ttft_ms']:.3f}ms TPOT={row['tpot_ms']:.3f}ms "
            f"TPOT-pass={row['meets_tpot']}"
        )
    return rows


if __name__ == "__main__":
    main()
