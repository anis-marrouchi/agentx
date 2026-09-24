"""Compare Harbor jobs: pass rate, time, tokens and cost per agent/model.

    python3 bench/harbor/report.py jobs/            # every job under jobs/
    python3 bench/harbor/report.py jobs/a jobs/b --csv out.csv
    python3 bench/harbor/report.py jobs/ --compare dev-baseline dev-agentx-abc123

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

--compare A B puts two jobs side by side, task by task. That is the mode to
optimize against: the same task run by both cancels most of the task-to-task
variance that makes small-sample pass rates useless. Per task it averages
the attempts each job SOLVED, then reports B/A as a geometric mean over the
tasks both jobs solved, with a 95% bootstrap interval over tasks. An
interval that straddles 1.0 means "no measurable change". Pass counts are
the guardrail: B solving 2+ fewer tasks than A is flagged as a regression
whatever the tokens say.
"""

import argparse
import csv
import json
import math
import random
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
                data["_job"] = f.parent.parent.name  # jobs/<job>/<trial>/result.json
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


def total_tokens(ctx: dict) -> int | None:
    if ctx.get("n_input_tokens") is None and ctx.get("n_output_tokens") is None:
        return None
    return (ctx.get("n_input_tokens") or 0) + (ctx.get("n_output_tokens") or 0)


def per_task(trials: list[dict]) -> dict[str, dict]:
    """Per task: attempts, solved attempts, and means over solved attempts."""
    out: dict[str, dict] = {}
    for t in trials:
        row = out.setdefault(t.get("task_name") or "?", {"attempts": 0, "solved": 0, "tokens": [], "cost": [], "time": []})
        row["attempts"] += 1
        if not solved(t):
            continue
        row["solved"] += 1
        ctx = t.get("agent_result") or {}
        if (tok := total_tokens(ctx)) is not None:
            row["tokens"].append(tok)
        if ctx.get("cost_usd") is not None:
            row["cost"].append(ctx["cost_usd"])
        if (s := seconds(t.get("agent_execution"))) is not None:
            row["time"].append(s)
    for row in out.values():
        for k in ("tokens", "cost", "time"):
            row[k] = statistics.mean(row[k]) if row[k] else None
    return out


def geomean_ratio(pairs: list[tuple[float, float]], seed: int = 0, n: int = 2000) -> tuple[float, float, float] | None:
    """Geometric mean of b/a over tasks, with a 95% bootstrap interval."""
    logs = [math.log(b / a) for a, b in pairs if a and b]
    if not logs:
        return None
    rng = random.Random(seed)
    boots = sorted(statistics.mean(rng.choices(logs, k=len(logs))) for _ in range(n))
    return (math.exp(statistics.mean(logs)), math.exp(boots[int(0.025 * n)]), math.exp(boots[int(0.975 * n) - 1]))


def compare(results: list[dict], a_job: str, b_job: str) -> dict:
    a = per_task([r for r in results if r["_job"] == a_job])
    b = per_task([r for r in results if r["_job"] == b_job])
    for name, rows in ((a_job, a), (b_job, b)):
        if not rows:
            sys.exit(f"no trials found for job {name!r}")
    tasks = sorted(set(a) | set(b))
    both = [t for t in tasks if t in a and t in b and a[t]["solved"] and b[t]["solved"]]
    ratios = {
        key: geomean_ratio([(a[t][key], b[t][key]) for t in both if a[t][key] and b[t][key]])
        for key in ("tokens", "cost", "time")
    }
    a_solved = sum(1 for t in a.values() if t["solved"])
    b_solved = sum(1 for t in b.values() if t["solved"])
    return {"a": a, "b": b, "tasks": tasks, "both": both, "ratios": ratios,
            "a_solved": a_solved, "b_solved": b_solved, "regression": b_solved <= a_solved - 2}


def print_compare(c: dict, a_job: str, b_job: str) -> None:
    print(f"A = {a_job}\nB = {b_job}\n")
    header = f"{'task':<30} {'A ok':>6} {'B ok':>6} {'A tok':>8} {'B tok':>8} {'A $':>7} {'B $':>7} {'B/A $':>6}"
    print(header)
    print("-" * len(header))
    k = lambda v: "—" if v is None else f"{v / 1e3:.0f}k"
    for t in c["tasks"]:
        ra, rb = c["a"].get(t), c["b"].get(t)
        ok = lambda r: "—" if r is None else f"{r['solved']}/{r['attempts']}"
        ca, cb = (ra or {}).get("cost"), (rb or {}).get("cost")
        ratio = f"{cb / ca:.2f}" if ca and cb and t in c["both"] else ""
        print(f"{t:<30.30} {ok(ra):>6} {ok(rb):>6} {k((ra or {}).get('tokens')):>8} {k((rb or {}).get('tokens')):>8} "
              f"{fmt(ca, '.2f'):>7} {fmt(cb, '.2f'):>7} {ratio:>6}")

    n = len(c["tasks"])
    print(f"\nsolved tasks: A {c['a_solved']}/{n}, B {c['b_solved']}/{n}; compared on {len(c['both'])} solved by both")
    for key, label in (("cost", "cost"), ("tokens", "tokens"), ("time", "time")):
        r = c["ratios"][key]
        if r is None:
            print(f"  {label:<7} no paired data")
            continue
        mid, lo, hi = r
        verdict = "no measurable change" if lo <= 1 <= hi else ("B lower" if hi < 1 else "B higher")
        print(f"  {label:<7} B/A {mid:.2f}  [95% {lo:.2f}–{hi:.2f}]  {verdict}")
    if c["regression"]:
        print("\nREGRESSION: B solved 2+ fewer tasks than A; reject regardless of cost.")


def fmt(v, spec: str) -> str:
    return "—" if v is None else format(v, spec)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", type=Path, help="job directories (or a parent of them)")
    ap.add_argument("--csv", type=Path, help="also write the table as CSV")
    ap.add_argument("--compare", nargs=2, metavar=("A_JOB", "B_JOB"), help="task-by-task comparison of two job names")
    args = ap.parse_args()

    if args.compare:
        c = compare(load(args.paths), *args.compare)
        print_compare(c, *args.compare)
        sys.exit(1 if c["regression"] else 0)

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
