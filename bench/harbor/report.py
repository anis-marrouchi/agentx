"""Compare Harbor jobs: pass rate, time, tokens and cost per agent/model.

    python3 bench/harbor/report.py jobs/            # every job under jobs/
    python3 bench/harbor/report.py jobs/a jobs/b --csv out.csv

Reads each trial's result.json and groups trials by agent, tier and model.
Only the standard library is needed. A trial counts as solved when its
verifier reward is >= 1; a trial with no verifier result counts as unsolved
(so crashes and timeouts cost pass rate, they are not dropped).

Columns:
    pass      solved / trials, with a 95% Wilson interval
    time      agent execution wall-clock, median and p90, in seconds
    tokens    mean per trial that recorded them: input (incl. cache), of which
              cache reads, output
    cost      mean per trial, and total cost / solved trials. Trials with no
              cost recorded are listed under "unpriced"; if any exist, the
              cost columns undercount.
"""

import argparse
import csv
import json
import math
import statistics
import sys
from datetime import datetime
from pathlib import Path


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def seconds(timing: dict | None) -> float | None:
    if not timing or not timing.get("started_at") or not timing.get("finished_at"):
        return None
    start = datetime.fromisoformat(timing["started_at"])
    end = datetime.fromisoformat(timing["finished_at"])
    return (end - start).total_seconds()


def solved(result: dict) -> bool:
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    if not rewards:
        return False
    value = rewards.get("reward", max(rewards.values()))
    return value >= 1


def group_key(result: dict) -> tuple[str, str, str]:
    agent_cfg = (result.get("config") or {}).get("agent") or {}
    info = result.get("agent_info") or {}
    name = info.get("name") or agent_cfg.get("name") or agent_cfg.get("import_path") or "?"
    tier = (agent_cfg.get("kwargs") or {}).get("tier", "")
    model = agent_cfg.get("model_name") or (info.get("model_info") or {}).get("name") or "?"
    return (name, tier, model)


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]


def load(paths: list[Path]) -> list[dict]:
    results = []
    for root in paths:
        for f in root.rglob("result.json"):
            try:
                data = json.loads(f.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if "trial_name" in data:  # skip job-level result.json files
                results.append(data)
    return results


def summarize(results: list[dict]) -> list[dict]:
    groups: dict[tuple, list[dict]] = {}
    for r in results:
        groups.setdefault(group_key(r), []).append(r)

    rows = []
    for (name, tier, model), trials in sorted(groups.items()):
        n = len(trials)
        k = sum(solved(t) for t in trials)
        lo, hi = wilson(k, n)
        times = [s for t in trials if (s := seconds(t.get("agent_execution"))) is not None]
        ctx = [t.get("agent_result") or {} for t in trials]
        costs = [c["cost_usd"] for c in ctx if c.get("cost_usd") is not None]
        # Mean over trials that recorded the field: an agent killed before
        # reporting has no count, which is not the same as zero tokens.
        def mean(key: str) -> float | None:
            vals = [c[key] for c in ctx if c.get(key) is not None]
            return statistics.mean(vals) if vals else None
        total_cost = sum(costs)
        rows.append({
            "agent": name + (f" [{tier}]" if tier else ""),
            "model": model,
            "trials": n,
            "solved": k,
            "pass_rate": k / n if n else 0,
            "ci_low": lo,
            "ci_high": hi,
            "errors": sum(1 for t in trials if t.get("exception_info")),
            "time_median_s": statistics.median(times) if times else None,
            "time_p90_s": percentile(times, 0.9),
            "input_tokens_mean": mean("n_input_tokens"),
            "cache_read_tokens_mean": mean("n_cache_tokens"),
            "output_tokens_mean": mean("n_output_tokens"),
            "cost_mean_usd": total_cost / len(costs) if costs else None,
            "cost_per_solved_usd": total_cost / k if costs and k else None,
            "unpriced": n - len(costs),
        })
    return rows


def fmt(v, spec: str) -> str:
    return "—" if v is None else format(v, spec)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", type=Path, help="job directories (or a parent of them)")
    ap.add_argument("--csv", type=Path, help="also write the table as CSV")
    args = ap.parse_args()

    rows = summarize(load(args.paths))
    if not rows:
        sys.exit("no trial result.json files found")

    header = f"{'agent':<28} {'model':<28} {'pass':>20} {'err':>4} {'time med/p90':>14} {'in/cache/out tokens':>24} {'$/trial':>8} {'$/solved':>9}"
    print(header)
    print("-" * len(header))
    for r in rows:
        pass_s = f"{r['solved']}/{r['trials']} {r['pass_rate']:.0%} [{r['ci_low']:.0%}-{r['ci_high']:.0%}]"
        time_s = f"{fmt(r['time_median_s'], '.0f')}/{fmt(r['time_p90_s'], '.0f')}s"
        k = lambda v, spec: "—" if v is None else format(v / 1e3, spec) + "k"
        tok_s = f"{k(r['input_tokens_mean'], '.0f')}/{k(r['cache_read_tokens_mean'], '.0f')}/{k(r['output_tokens_mean'], '.1f')}"
        print(f"{r['agent']:<28.28} {r['model']:<28.28} {pass_s:>20} {r['errors']:>4} {time_s:>14} {tok_s:>24} "
              f"{fmt(r['cost_mean_usd'], '.2f'):>8} {fmt(r['cost_per_solved_usd'], '.2f'):>9}"
              + (f"  ({r['unpriced']} unpriced)" if r["unpriced"] else ""))

    if args.csv:
        with args.csv.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        print(f"\nwrote {args.csv}")


if __name__ == "__main__":
    main()
