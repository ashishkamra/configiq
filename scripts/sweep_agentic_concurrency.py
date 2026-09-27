"""Sweep this repo's ConfigIQ /api/recommend for an agentic Qwen3.6 workload.

Run: python3 scripts/sweep_agentic_concurrency.py --end 16
Resume after interruption by running the same command again. No third-party packages.
"""

import argparse
import csv
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


URL = "http://localhost:3000/api/recommend"
MODEL = "nvidia/Qwen3.6-27B-NVFP4"
SYSTEM = "rtx_pro_6000_server"
OUTPUT = Path("docs/agentic-concurrency-sweep/configiq-local")
BASE = {
    "model_path": MODEL,
    "system": SYSTEM,
    "backend": "vllm",
    "isl": 32768,
    "osl": 2048,
    "prefix": 30000,
    "ttft": 3000,
    "tpot": 50,
}
FIELDS = (
    "target_concurrency",
    "status",
    "http_status",
    "gpus_required",
    "chosen_mode",
    "replicas",
    "gpus_per_replica",
    "ttft_ms",
    "tpot_ms",
    "reported_concurrency",
    "batch_size",
    "memory_gb",
    "request_id",
    "error",
)


def payload(concurrency):
    return {**BASE, "target_concurrency": concurrency}


def probe(concurrency, timeout=120, url=URL):
    body = payload(concurrency)
    request = Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    for attempt in range(3):
        try:
            with urlopen(request, timeout=timeout) as response:
                return {
                    "request": body,
                    "url": url,
                    "http_status": response.status,
                    "response": json.load(response),
                }
        except HTTPError as exc:
            raw = exc.read().decode(errors="replace")
            try:
                result = json.loads(raw)
            except ValueError:
                result = {"detail": raw}
            if exc.code not in (429, 502, 503, 504) or attempt == 2:
                return {
                    "request": body,
                    "url": url,
                    "http_status": exc.code,
                    "response": result,
                }
        except (URLError, TimeoutError, ValueError, OSError) as exc:
            if attempt == 2:
                return {
                    "request": body,
                    "url": url,
                    "http_status": None,
                    "response": {"detail": str(exc)},
                }
        time.sleep(2**attempt)
    return {
        "request": body,
        "url": url,
        "http_status": None,
        "response": {"detail": "Retries exhausted"},
    }


def load_records(path, url=URL):
    records = {}
    if path.exists():
        for line in path.read_text().splitlines():
            item = json.loads(line)
            target = item["request"]["target_concurrency"]
            if item["request"] != payload(target) or item.get("url") != url:
                raise ValueError(
                    f"Cached request for concurrency {target} has different workload settings"
                )
            records[target] = item
    return records


def is_infeasible(record):
    response = record["response"]
    return (
        record["http_status"] == 422
        and isinstance(response, dict)
        and response.get("status") == "failed"
        and response.get("error", {}).get("code") == "AISIM_NO_CONFIGURATION"
    )


def valid_configs(record):
    response = record["response"]
    if (
        record["http_status"] != 200
        or not isinstance(response, dict)
        or response.get("status") != "completed"
    ):
        return []
    config, performance = response.get("recommendation"), response.get("performance")
    if not isinstance(config, dict) or not isinstance(performance, dict):
        return []
    gpu, ttft, tpot = (
        config.get("gpusNeeded"),
        performance.get("ttftLatencyMs"),
        performance.get("tpotMs"),
    )
    concurrency = performance.get("concurrency")
    if (
        isinstance(gpu, int)
        and gpu > 0
        and isinstance(ttft, (int, float))
        and 0 <= ttft <= BASE["ttft"]
        and isinstance(tpot, (int, float))
        and 0 <= tpot <= BASE["tpot"]
        and isinstance(concurrency, int)
        and concurrency >= record["request"]["target_concurrency"]
    ):
        return [config]
    return []


def summarize(records, end=256):
    rows = []
    for c in range(1, end + 1):
        rec = records.get(c)
        row: dict[str, object] = dict.fromkeys(FIELDS, "")
        row["target_concurrency"] = c
        if rec is None:
            row["status"] = "missing"
        else:
            row["http_status"] = (
                rec["http_status"] if rec["http_status"] is not None else ""
            )
            configs = valid_configs(rec)
            if configs:
                best = configs[0]
                performance = rec["response"]["performance"]
                row.update(
                    status="feasible",
                    gpus_required=best["gpusNeeded"],
                    chosen_mode=rec["response"]["mode"],
                    replicas=best.get("replicasNeeded"),
                    gpus_per_replica=best.get("gpusPerReplica"),
                    ttft_ms=performance["ttftLatencyMs"],
                    tpot_ms=performance["tpotMs"],
                    reported_concurrency=performance["concurrency"],
                    batch_size=best.get("batchSize"),
                    memory_gb=rec["response"].get("memory", {}).get("value"),
                    request_id=rec["response"].get("requestId"),
                )
            elif is_infeasible(rec):
                row["status"] = "infeasible"
            else:
                row["status"] = "error"
                row["error"] = json.dumps(rec["response"], sort_keys=True)
        rows.append(
            {key: value if value is not None else "" for key, value in row.items()}
        )

    budgets = []
    for gpu_budget in range(1, 9):
        candidates = [
            r
            for r in rows
            if r["status"] == "feasible" and r["gpus_required"] <= gpu_budget
        ]
        best = (
            max(candidates, key=lambda r: r["target_concurrency"])
            if candidates
            else None
        )
        next_row = (
            rows[best["target_concurrency"]]
            if best and best["target_concurrency"] < end
            else None
        )
        boundary_checked = next_row is not None and (
            next_row["status"] == "infeasible"
            or (
                next_row["status"] == "feasible"
                and next_row["gpus_required"] > gpu_budget
            )
        )
        budgets.append(
            {
                "gpu_budget": gpu_budget,
                "max_tested_concurrency": best["target_concurrency"] if best else "",
                "gpus_required": best["gpus_required"] if best else "",
                "chosen_mode": best["chosen_mode"] if best else "",
                "replicas": best["replicas"] if best else "",
                "gpus_per_replica": best["gpus_per_replica"] if best else "",
                "ttft_ms": best["ttft_ms"] if best else "",
                "tpot_ms": best["tpot_ms"] if best else "",
                "reported_concurrency": best["reported_concurrency"] if best else "",
                "batch_size": best["batch_size"] if best else "",
                "memory_gb": best["memory_gb"] if best else "",
                "status": (
                    f"at least {end}; sweep capped"
                    if best and best["target_concurrency"] == end
                    else "adjacent boundary checked; monotonicity assumed"
                    if boundary_checked
                    else "lower bound; next target untested or unresolved"
                    if best
                    else "no feasible result in sweep"
                ),
            }
        )
    return rows, budgets


def write_csv(path, rows, fields):
    with path.open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_svg(path, budgets, end):
    width, height = 860, 465
    x = lambda gpu: 90 + (gpu - 1) * 99
    ceiling = max(end, 4)
    y = lambda c: 375 - c * 260 / ceiling
    points = [
        (x(r["gpu_budget"]), y(r["max_tested_concurrency"]), r)
        for r in budgets
        if r["max_tested_concurrency"] != ""
    ]
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="white"/>',
        '<g font-family="sans-serif" fill="#151515">',
        '<text x="65" y="30" font-size="19">Qwen3.6-27B NVFP4: feasible concurrent turns by GPU budget</text>',
        '<text x="65" y="53" font-size="13">32,768 ISL / 2,048 OSL · 30,000 cached tokens · TTFT ≤3 s · TPOT ≤50 ms</text>',
        '<path d="M90 115 V375 H783" fill="none" stroke="#3c3f42" stroke-width="2"/>',
    ]
    for tick in (0, ceiling // 4, ceiling // 2, 3 * ceiling // 4, ceiling):
        parts.append(f'<path d="M90 {y(tick):.1f} H783" stroke="#ddd"/>')
        parts.append(
            f'<text x="77" y="{y(tick) + 4:.1f}" font-size="12" text-anchor="end">{tick}</text>'
        )
    for gpu in range(1, 9):
        parts.append(
            f'<text x="{x(gpu)}" y="398" font-size="13" text-anchor="middle">{gpu}</text>'
        )
    parts.append(
        '<text x="437" y="433" text-anchor="middle" font-size="14">RTX PRO 6000 GPU budget</text>'
    )
    parts.append(
        f'<text transform="translate(21 225) rotate(-90)" text-anchor="middle" font-size="14">Feasible concurrent turns (tested ≤{end})</text>'
    )
    # Do not connect points across GPU budgets with no feasible result.
    for px, py, row in points:
        parts.append(f'<circle cx="{px}" cy="{py:.1f}" r="6" fill="#0066cc"/>')
        parts.append(
            f'<text x="{px}" y="{py - 13:.1f}" font-size="12" text-anchor="middle">{row["max_tested_concurrency"]} (uses {row["gpus_required"]})</text>'
        )
    parts.append("</g></svg>")
    path.write_text("\n".join(parts) + "\n")


def write_report(path, rows, budgets, end, url, extra_count=0):
    statuses = {
        status: sum(row["status"] == status for row in rows)
        for status in ("feasible", "infeasible", "error", "missing")
    }
    sampled = [row for row in rows if row["status"] == "feasible"]
    nonmonotonic = [
        (previous["target_concurrency"], current["target_concurrency"])
        for previous, current in zip(sampled, sampled[1:])
        if previous["gpus_required"] > current["gpus_required"]
    ]
    lines = [
        "# Agentic/coding concurrency sweep",
        "",
        f"Predictions via ConfigIQ `{url}` for `nvidia/Qwen3.6-27B-NVFP4` on",
        "`rtx_pro_6000_server` (RTX PRO 6000 Blackwell Server Edition).",
        "",
        "- Workload: 32,768 input tokens; 2,048 output tokens; 30,000 shared-prefix tokens (91.55% of input).",
        "- Limits: TTFT ≤3,000 ms and non-inclusive TPOT ≤50 ms; vLLM and HYBRID database defaults.",
        f"- Requested target range 1–{end}; {len(rows) - statuses['missing']} target responses saved. Only `target_concurrency` varies; no GPU cap or `top_n` override.",
        "- ConfigIQ's `recommendation.gpusNeeded` is the GPU count for each target; `performance.concurrency` is reported separately and is not the swept target.",
        "- Reverse-mapped highest successful **target** for each GPU **budget**; actual GPUs can be lower. If the last target passes, capacity is only lower-bounded.",
        "- Adjacent targets were checked at each GPU step. Untested targets between samples require the assumption that recommended GPU count does not decrease as requested concurrency increases.",
        f"- Sampled GPU counts {'were nondecreasing' if not nonmonotonic else 'WERE NONMONOTONIC: ' + str(nonmonotonic)} as target concurrency increased.",
        "- Predictions are not p95 observations and exclude agent tool-wait time; a replay with warm shared prefixes is needed before claiming deployed capacity.",
        "- An earlier direct public-gateway experiment returned contradictory results and was discarded; the parent README links here.",
        "",
        f"Sweep statuses: {statuses}.",
        "",
        "| GPU budget | Highest tested target | GPUs used | Mode | Replicas × GPUs | Reported concurrency | TTFT (ms) | TPOT (ms) | Note |",
        "| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for row in budgets:
        topology = (
            f"{row['replicas']} × {row['gpus_per_replica']}"
            if row["replicas"] != ""
            else "—"
        )
        lines.append(
            "| "
            + " | ".join(
                (f"{value:.1f}" if isinstance(value, float) else str(value) or "—")
                for value in (
                    row["gpu_budget"],
                    row["max_tested_concurrency"],
                    row["gpus_required"],
                    row["chosen_mode"],
                    topology,
                    row["reported_concurrency"],
                    row["ttft_ms"],
                    row["tpot_ms"],
                    row["status"],
                )
            )
            + " |"
        )
    if statuses["error"] or statuses["missing"]:
        lines.extend(
            [
                "",
                f"**Sampling:** {statuses['missing']} integer targets were not probed; {statuses['error']} probes errored. The limits above are adjacent-boundary checked only when stated, not an exhaustive 1–{end} sweep.",
            ]
        )
    if nonmonotonic:
        lines.append(
            "**Warning:** nonmonotonic recommendations invalidate interpolation between sampled targets."
        )
    fixed_path = path.parent / "fixed_eight_gpu_tpot.csv"
    if fixed_path.exists():
        with fixed_path.open(newline="") as file:
            fixed_rows = list(csv.DictReader(file))
        lines.extend(
            [
                "",
                "## Fixed eight-GPU TPOT ramp",
                "",
                "The installed AISimulate 0.12.0 SDK's `cli_estimate` modeled four independent two-GPU replicas with 30,000 cached-prefix tokens. "
                "The repo's REST `/estimate` does not expose `prefix`, so this uses the installed SDK directly.",
                "The two-GPU replica at batch 64 reproduces the `/recommend` result (678.991 ms TTFT, 49.903 ms TPOT). "
                "All estimates use the raw recommendation's `gemm=fp8_static`, `kvcache=fp8`, `fmha=bfloat16` settings. "
                "**Caution:** despite the NVFP4 model ID, the estimator reports FP8-static GEMM; these results do not verify NVFP4-kernel performance.",
                "",
                "| Batch per 2-GPU replica | 4-replica capacity | TTFT (ms) | TPOT (ms) | TPOT ≤50 ms? |",
                "| ---: | ---: | ---: | ---: | :---: |",
            ]
        )
        for row in fixed_rows:
            lines.append(
                f"| {row['batch_per_replica']} | {row['four_replica_capacity']} | "
                f"{float(row['ttft_ms']):.3f} | {float(row['tpot_ms']):.3f} | "
                f"{'Yes' if row['meets_tpot'] == 'True' else 'No'} |"
            )
        lines.extend(
            [
                "",
                "![TPOT ramp on a fixed eight-GPU deployment](fixed_eight_gpu_tpot.svg)",
                "",
                "With this topology, 256 simultaneous turns mean 64 on each replica. At 257, at least one of four replicas "
                "must handle 65, whose predicted TPOT is 51.161 ms, above the hard 50 ms constraint. "
                "This is a per-replica worst-case constraint, **not** a measured p95 service-level claim.",
                "The `/recommend` result for target 257 changes to 10 GPUs (5 × 2) and retains 49.903 ms TPOT; "
                "it does not report TPOT on the fixed eight-GPU topology above 256.",
                "",
                "See `fixed_eight_gpu_tpot.csv` and rerun "
                "`services/aisimulators/.venv/bin/python3 scripts/fixed_eight_gpu_tpot.py` to reproduce the fixed-topology curve.",
            ]
        )
    lines.extend(
        [
            "",
            "![Maximum feasible concurrent turns by GPU budget](capacity.svg)",
            "",
            f"See `probes.csv` for the {end} target slots (missing rows were not probed) and `raw_in_scope.jsonl` for saved ConfigIQ responses.",
            "",
            f"Regenerate (resumes existing successful/422 responses): `python3 scripts/sweep_agentic_concurrency.py --end {end}`.",
            "",
        ]
    )
    if extra_count:
        lines.extend(
            [
                f"The response log also contains {extra_count} responses beyond {end}; they were excluded from this analysis.",
                "",
            ]
        )
    path.write_text("\n".join(lines))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int, default=16)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--url", default=URL, help="ConfigIQ /api/recommend endpoint")
    parser.add_argument(
        "--targets",
        help="Comma-separated target concurrencies; use cached responses for other targets",
    )
    args = parser.parse_args()
    if not 1 <= args.start <= args.end <= 512 or not 1 <= args.workers <= 8:
        parser.error("Expected 1 <= start <= end <= 512 and 1 <= workers <= 8")
    try:
        targets = (
            [int(value) for value in args.targets.split(",")]
            if args.targets
            else list(range(args.start, args.end + 1))
        )
    except ValueError:
        parser.error("--targets must contain comma-separated integers")
    if not targets or any(
        target < args.start or target > args.end for target in targets
    ):
        parser.error("--targets must be between --start and --end")
    args.output.mkdir(parents=True, exist_ok=True)
    raw = args.output / "raw.jsonl"
    records = load_records(raw, args.url)
    pending = [
        c
        for c in sorted(set(targets))
        if c not in records
        or (records[c]["http_status"] != 200 and not is_infeasible(records[c]))
    ]
    print(f"{len(pending)} API probes pending; {len(records)} cached", flush=True)
    with ThreadPoolExecutor(max_workers=args.workers) as pool, raw.open("a") as file:
        tasks = {pool.submit(probe, c, 120, args.url): c for c in pending}
        for future in as_completed(tasks):
            c = tasks[future]
            record = future.result()
            file.write(json.dumps(record, separators=(",", ":")) + "\n")
            file.flush()
            records[c] = record
            print(
                f"{c}: HTTP {record['http_status']} ({len(valid_configs(record))} valid configs)",
                flush=True,
            )
    rows, budgets = summarize(records, end=args.end)
    (args.output / "raw_in_scope.jsonl").write_text(
        "".join(
            json.dumps(records[c], separators=(",", ":")) + "\n"
            for c in range(1, args.end + 1)
            if c in records
        )
    )
    write_csv(args.output / "probes.csv", rows, FIELDS)
    write_csv(args.output / "capacity.csv", budgets, tuple(budgets[0]))
    write_svg(args.output / "capacity.svg", budgets, args.end)
    write_report(
        args.output / "README.md",
        rows,
        budgets,
        args.end,
        args.url,
        sum(c > args.end for c in records),
    )
    print(f"Reports written to {args.output}", flush=True)
    return 1 if any(row["status"] == "error" for row in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
