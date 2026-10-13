#!/usr/bin/env python3
"""
Small reusable workflows (#928): how much could folding repeated tool-call
slices into one call save, read from recorded Claude Code session logs.

Reads ~/.claude/projects/*/*.jsonl (main sessions only, not subagents) for a
fixed date window. No model is called and nothing is written outside --out
and --json.

  count     Find slices of consecutive tool calls that repeat across sessions
            and seats, and price the round trips they would remove.
  outline   Write bounded tool outlines of a sample of sessions spread over
            the seats, for a mining agent to read (step 1 of the test).
  mark      Mark where a catalog of proposed workflows would have applied in
            sessions the mining agent did not see, price the round trips
            removed, and write a sample of marked places for a hand check
            (steps 2 and 3).
  prices    Print the price table this script uses, as JSON.

Usage:
  python3 bench/slice-replay.py count --from 2026-10-09 --to 2026-10-12
  python3 bench/slice-replay.py count --from ... --to ... --level kind
  python3 bench/slice-replay.py outline --from ... --to ... --sample 60 --out mine/
  python3 bench/slice-replay.py mark --from ... --to ... --catalog catalog.json --seen mine/seen.json --out marked/

A seat is one project folder under ~/.claude/projects (one agent workspace).
A round trip is one model request (one assistant message id); calls the model
sends in parallel share one. Folding a slice that spans requests R1..Rk into
one call removes R2..Rk. The low saving prices only what those requests
re-read from the cache; the high saving prices their whole cost.

Prices are list prices per million tokens, the table in
src/daemon/token-tracker.ts (CACHE_AWARE_PRICING); the 200k-token long-context
tier is left out. A test checks the two tables match.
"""

import argparse
import json
import random
import re
import shlex
from collections import defaultdict
from pathlib import Path

# Kept equal to CACHE_AWARE_PRICING in src/daemon/token-tracker.ts (test/slice-replay.test.ts).
PRICES = {
    "claude-fable": {"input": 10, "output": 50, "cacheRead": 1, "cacheCreate": 12.5},
    "claude-opus-5": {"input": 5, "output": 25, "cacheRead": 0.5, "cacheCreate": 6.25},
    "claude-opus-4-8": {"input": 5, "output": 25, "cacheRead": 0.5, "cacheCreate": 6.25},
    "claude-opus-4-7": {"input": 5, "output": 25, "cacheRead": 0.5, "cacheCreate": 6.25},
    "claude-opus-4-6": {"input": 5, "output": 25, "cacheRead": 0.5, "cacheCreate": 6.25},
    "claude-opus-4-5": {"input": 5, "output": 25, "cacheRead": 0.5, "cacheCreate": 6.25},
    "claude-opus": {"input": 15, "output": 75, "cacheRead": 1.5, "cacheCreate": 18.75},
    "claude-sonnet-5": {"input": 2, "output": 10, "cacheRead": 0.2, "cacheCreate": 2.5},
    "claude-sonnet": {"input": 3, "output": 15, "cacheRead": 0.3, "cacheCreate": 3.75},
    "claude-haiku": {"input": 1, "output": 5, "cacheRead": 0.1, "cacheCreate": 1.25},
}


def family(model):
    """Same mapping as getModelFamily in src/daemon/token-tracker.ts."""
    m = (model or "").lower()
    has = lambda *n: any(x in m for x in n)
    if has("fable", "mythos"):
        return "claude-fable"
    if "opus" in m:
        for key, fam in (("opus-5", "claude-opus-5"), ("opus5", "claude-opus-5"), ("4-8", "claude-opus-4-8"), ("4.8", "claude-opus-4-8"),
                         ("4-7", "claude-opus-4-7"), ("4.7", "claude-opus-4-7"), ("4-6", "claude-opus-4-6"), ("4.6", "claude-opus-4-6"),
                         ("4-5", "claude-opus-4-5"), ("4.5", "claude-opus-4-5")):
            if key in m:
                return fam
        if has("4-1", "4.1", "opus-3", "opus3", "-3-"):
            return "claude-opus"
        return "claude-opus-5"
    if "haiku" in m:
        return "claude-haiku"
    if has("sonnet-5", "sonnet5"):
        return "claude-sonnet-5"
    return "claude-sonnet"


def cost(model, usage):
    """(whole cost, cache re-read cost) in USD for one request."""
    p = PRICES[family(model)]
    reread = usage.get("cache_read_input_tokens", 0) / 1e6 * p["cacheRead"]
    whole = (reread
             + usage.get("input_tokens", 0) / 1e6 * p["input"]
             + usage.get("cache_creation_input_tokens", 0) / 1e6 * p["cacheCreate"]
             + usage.get("output_tokens", 0) / 1e6 * p["output"])
    return whole, reread


# ---- labels ----------------------------------------------------------------

# Programs whose first words after the name are subcommands worth keeping.
SUBCOMMANDS = {"gh": 2, "git": 1, "pnpm": 1, "npm": 1, "npx": 1, "agentx": 2, "docker": 1, "kubectl": 1, "cargo": 1, "go": 1, "yarn": 1}
SPLIT_RE = re.compile(r"\s*(?:&&|\|\||;|\|)\s*")
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
NUM_RE = re.compile(r"\b\d+\b")
FILE_TOOLS = {"Read", "Edit", "Write", "MultiEdit", "NotebookEdit"}
SEARCH_TOOLS = {"Grep", "Glob", "LS"}


def shell_command(command):
    """First real command of a shell line: 'gh pr view', 'grep', 'python3'."""
    for part in SPLIT_RE.split(command or ""):
        try:
            words = shlex.split(part, comments=True)
        except ValueError:
            words = part.split()
        while words and ENV_RE.match(words[0]):
            words = words[1:]
        while words and words[0] in ("sudo", "time", "env", "timeout", "nohup"):
            words = words[1:]
            if words and words[0][:1].isdigit():
                words = words[1:]
        if not words or words[0] in ("cd", "export", "set", "source", "."):
            continue
        name = words[0].rsplit("/", 1)[-1]
        keep, subs = SUBCOMMANDS.get(name, 0), []
        for w in words[1:]:
            if len(subs) >= keep or w.startswith("-"):
                break
            subs.append(w)
        return " ".join([name] + subs)
    return "?"


def is_memory(path):
    p = (path or "").lower()
    return "/memory/" in p or p.endswith("memory.md") or "/.agentx/memory" in p


def label(name, args, level):
    """A call's name at the requested level: 'kind' (shell, file) or 'command'."""
    if name == "Bash":
        return "shell" if level == "kind" else "bash:" + shell_command(args.get("command", ""))
    if name in FILE_TOOLS:
        if level == "kind":
            return "file"
        return name + (":memory" if is_memory(args.get("file_path") or args.get("notebook_path")) else "")
    if name in SEARCH_TOOLS:
        return "search" if level == "kind" else name
    if name.startswith("mcp__"):
        return "mcp:" + name.split("__")[1] if level == "kind" else name
    return "other" if level == "kind" else name


def arg_shape(name, args, width=120):
    """A bounded view of the arguments: numbers as <n>, nothing past width."""
    if name == "Bash":
        text = args.get("command", "")
    elif name in FILE_TOOLS:
        text = args.get("file_path") or args.get("notebook_path") or ""
    elif name in SEARCH_TOOLS:
        text = " ".join(str(args.get(k, "")) for k in ("pattern", "path", "glob") if args.get(k))
    else:
        text = " ".join(f"{k}=" for k in sorted(args)) if isinstance(args, dict) else ""
    text = NUM_RE.sub("<n>", " ".join(str(text).split()))
    return text if len(text) <= width else text[: width - 1] + "…"


# ---- reading logs ----------------------------------------------------------

def load_session(path, since, until):
    """Requests of one main session in the window, in order.

    Each request: {id, day, model, usage, calls: [(tool, args)]}. One
    assistant message is spread over several log lines that repeat its usage;
    the usage is counted once per message id."""
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return []
    order, by_id = [], {}
    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("isSidechain") or obj.get("type") != "assistant":
            continue
        msg = obj.get("message") or {}
        mid = msg.get("id") or obj.get("uuid")
        if mid not in by_id:
            day = (obj.get("timestamp") or "")[:10]
            by_id[mid] = {"id": mid, "day": day, "model": msg.get("model", ""), "usage": msg.get("usage") or {}, "calls": []}
            order.append(mid)
        content = msg.get("content")
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                args = block.get("input") if isinstance(block.get("input"), dict) else {}
                by_id[mid]["calls"].append((block.get("name", "?"), args))
    return [r for r in (by_id[m] for m in order) if since <= r["day"] <= until and r["model"] != "<synthetic>"]


def load_all(projects, since, until):
    """{(seat, session): requests} for every main session with a request in the window."""
    sessions = {}
    for path in sorted(Path(projects).glob("*/*.jsonl")):
        requests = load_session(path, since, until)
        if requests:
            sessions[(path.parent.name, path.stem)] = requests
    return sessions


def flatten(requests, level):
    """Calls of a session in order: (label, shape, request index)."""
    out = []
    for i, r in enumerate(requests):
        for name, args in r["calls"]:
            out.append((label(name, args, level), arg_shape(name, args), name, i))
    return out


def spend(sessions):
    total = 0.0
    for requests in sessions.values():
        for r in requests:
            total += cost(r["model"], r["usage"])[0]
    return total


def removed_cost(requests, first, last):
    """Whole and re-read cost of requests first+1..last (the ones a fold removes)."""
    whole = reread = 0.0
    for r in requests[first + 1: last + 1]:
        w, rr = cost(r["model"], r["usage"])
        whole += w
        reread += rr
    return whole, reread


# ---- count -----------------------------------------------------------------

def count(args):
    sessions = load_all(args.projects, args.since, args.until)
    total_spend = spend(sessions)
    calls = {k: flatten(v, args.level) for k, v in sessions.items()}
    tool_requests = sum(1 for v in sessions.values() for r in v if r["calls"])
    n_calls = sum(len(v) for v in calls.values())

    seen = defaultdict(lambda: (set(), set()))
    for (seat, sid), cs in calls.items():
        labels = [c[0] for c in cs]
        for n in range(2, args.max_len + 1):
            for i in range(len(labels) - n + 1):
                gram = tuple(labels[i: i + n])
                if args.skip_repeats and len(set(gram)) == 1:
                    continue
                seen[gram][0].add(sid)
                seen[gram][1].add(seat)
    keep = {g for g, (ss, seats) in seen.items() if len(ss) >= args.min_sessions and len(seats) >= args.min_seats}

    # Mark each session greedily, longest pattern first, without overlap.
    covered_calls, low, high = 0, 0.0, 0.0
    per_gram = defaultdict(lambda: {"places": 0, "calls": 0, "low": 0.0, "high": 0.0})
    for key, cs in calls.items():
        labels, used, i = [c[0] for c in cs], [False] * len(cs), 0
        for n in range(args.max_len, 1, -1):
            i = 0
            while i <= len(labels) - n:
                gram = tuple(labels[i: i + n])
                if gram in keep and not any(used[i: i + n]):
                    whole, reread = removed_cost(sessions[key], cs[i][3], cs[i + n - 1][3])
                    for j in range(i, i + n):
                        used[j] = True
                    b = per_gram[gram]
                    b["places"] += 1
                    b["calls"] += n
                    b["low"] += reread
                    b["high"] += whole
                    covered_calls += n
                    low += reread
                    high += whole
                    i += n
                else:
                    i += 1

    pct = lambda x: x / total_spend * 100 if total_spend else 0.0
    top = sorted(per_gram.items(), key=lambda kv: -kv[1]["high"])[: args.top]
    result = {
        "from": args.since, "to": args.until, "level": args.level,
        "minSessions": args.min_sessions, "minSeats": args.min_seats, "maxLen": args.max_len, "skipRepeats": args.skip_repeats,
        "sessions": len(sessions), "seats": len({s for s, _ in sessions}), "toolRequests": tool_requests, "calls": n_calls,
        "spendUsd": round(total_spend, 4), "patterns": len(keep),
        "coveredCalls": covered_calls, "coveredShare": round(covered_calls / n_calls * 100, 2) if n_calls else 0.0,
        "savingLowPct": round(pct(low), 2), "savingHighPct": round(pct(high), 2),
        "topPatterns": [{"slice": list(g), **b, "low": round(b["low"], 4), "high": round(b["high"], 4), "highPct": round(pct(b["high"]), 2)} for g, b in top],
    }
    result["topShareHighPct"] = round(sum(t["highPct"] for t in result["topPatterns"]), 2)

    print(f"Slice replay {args.since}..{args.until}, level {args.level}, seen in {args.min_sessions}+ sessions and {args.min_seats}+ seats"
          f"{', one command repeated left out' if args.skip_repeats else ''}")
    print(f"  {result['sessions']} main sessions on {result['seats']} seats, {tool_requests} requests with a tool, {n_calls} calls, {total_spend:.2f} USD")
    print(f"  {len(keep)} repeated slices; {covered_calls} calls inside one ({result['coveredShare']}%)")
    print(f"  saving if each became one call: {result['savingLowPct']}% (re-reads only) to {result['savingHighPct']}% (whole cost) of spend")
    print(f"\n  top {len(top)} slices hold {result['topShareHighPct']}% of spend")
    for t in result["topPatterns"]:
        print(f"    {t['highPct']:>5.2f}%  {t['places']:>4} places  {' > '.join(t['slice'])[:110]}")
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2))
        print(f"\nSaved {args.out}")


# ---- outline ---------------------------------------------------------------

def sample_spread(keys, n, seed):
    """Up to n sessions, taken round-robin over seats so each seat is in."""
    rng = random.Random(seed)
    by_seat = defaultdict(list)
    for seat, sid in keys:
        by_seat[seat].append((seat, sid))
    for v in by_seat.values():
        rng.shuffle(v)
    picked, seats = [], sorted(by_seat)
    while len(picked) < n and any(by_seat.values()):
        for seat in seats:
            if by_seat[seat] and len(picked) < n:
                picked.append(by_seat[seat].pop())
    return picked


def outline_text(seat, sid, requests):
    lines = [f"# {seat} / {sid}", ""]
    for i, r in enumerate(requests):
        for name, a in r["calls"]:
            lines.append(f"{i:>4}  {label(name, a, 'command'):<28} {arg_shape(name, a)}")
    return "\n".join(lines) + "\n"


def outline(args):
    sessions = load_all(args.projects, args.since, args.until)
    keys = [k for k, v in sessions.items() if any(r["calls"] for r in v)]
    picked = sample_spread(keys, args.sample, args.seed)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for seat, sid in picked:
        (out / f"{seat[:60]}__{sid}.txt").write_text(outline_text(seat, sid, sessions[(seat, sid)]))
    (out / "seen.json").write_text(json.dumps(sorted(sid for _, sid in picked), indent=2))
    print(f"Wrote {len(picked)} outlines from {len({s for s, _ in picked})} seats to {out}/ (seen.json lists them)")


# ---- mark ------------------------------------------------------------------

def load_catalog(path):
    """[{id, steps: [regex, ...]}]. A step matches 'label<TAB>argument shape'."""
    raw = json.loads(Path(path).read_text())
    items = raw.get("workflows", raw) if isinstance(raw, dict) else raw
    out = []
    for w in items:
        steps = [re.compile(s) for s in w["steps"]]
        if len(steps) < 2:
            raise SystemExit(f"workflow {w.get('id')}: needs 2+ steps, a single call folds nothing")
        out.append({"id": w["id"], "steps": steps})
    return out


def mark(args):
    sessions = load_all(args.projects, args.since, args.until)
    seen = set(json.loads(Path(args.seen).read_text())) if args.seen else set()
    unseen = {k: v for k, v in sessions.items() if k[1] not in seen}
    total_spend = spend(unseen)
    catalog = load_catalog(args.catalog)
    per = {w["id"]: {"places": 0, "low": 0.0, "high": 0.0} for w in catalog}
    places = []
    for key, requests in unseen.items():
        cs = flatten(requests, "command")
        used, i = [False] * len(cs), 0
        while i < len(cs):
            hit = None
            for w in catalog:
                n = len(w["steps"])
                if i + n <= len(cs) and not any(used[i: i + n]) and all(s.search(f"{c[0]}\t{c[1]}") for s, c in zip(w["steps"], cs[i: i + n])):
                    hit = (w, n)
                    break
            if not hit:
                i += 1
                continue
            w, n = hit
            whole, reread = removed_cost(requests, cs[i][3], cs[i + n - 1][3])
            per[w["id"]]["places"] += 1
            per[w["id"]]["low"] += reread
            per[w["id"]]["high"] += whole
            after = cs[i + n] if i + n < len(cs) else None
            places.append({"workflow": w["id"], "seat": key[0], "session": key[1],
                           "calls": [f"{c[0]}  {c[1]}" for c in cs[i: i + n]],
                           "next": f"{after[0]}  {after[1]}" if after else None})
            for j in range(i, i + n):
                used[j] = True
            i += n

    pct = lambda x: x / total_spend * 100 if total_spend else 0.0
    low, high = sum(b["low"] for b in per.values()), sum(b["high"] for b in per.values())
    result = {
        "from": args.since, "to": args.until, "unseenSessions": len(unseen), "leftOut": len(sessions) - len(unseen),
        "spendUsd": round(total_spend, 4), "places": len(places),
        "savingLowPct": round(pct(low), 2), "savingHighPct": round(pct(high), 2),
        "byWorkflow": {k: {**b, "low": round(b["low"], 4), "high": round(b["high"], 4), "highPct": round(pct(b["high"]), 2)} for k, b in per.items()},
    }
    print(f"Mark {args.since}..{args.until}: {len(unseen)} unseen sessions ({result['leftOut']} left out as seen), {total_spend:.2f} USD")
    print(f"  {len(places)} places; saving {result['savingLowPct']}% (re-reads only) to {result['savingHighPct']}% (whole cost) of spend")
    for k, b in sorted(result["byWorkflow"].items(), key=lambda kv: -kv[1]["high"]):
        print(f"    {b['highPct']:>5.2f}%  {b['places']:>4} places  {k}")

    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "mark.json").write_text(json.dumps(result, indent=2))
        rng = random.Random(args.seed)
        sample = rng.sample(places, min(args.check, len(places)))
        lines = ["# Hand check", "",
                 "For each place: could the inputs be filled without judgment, and would one result have been enough?",
                 "Write pass or fail after each heading. `next` is the call the agent made right after.", ""]
        for n, p in enumerate(sample, 1):
            lines += [f"## {n}. {p['workflow']} ({p['seat']} / {p['session']})", "", "```"] + p["calls"] + ["```", f"next: `{p['next']}`", "", "verdict: ", ""]
        (out / "hand-check.md").write_text("\n".join(lines))
        print(f"\nSaved {out}/mark.json and {out}/hand-check.md ({len(sample)} places)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def window(p):
        p.add_argument("--from", dest="since", required=True)
        p.add_argument("--to", dest="until", required=True)
        p.add_argument("--projects", default=str(Path.home() / ".claude" / "projects"))

    p = sub.add_parser("count", help="find repeated slices and price them")
    window(p)
    p.add_argument("--level", choices=["command", "kind"], default="command")
    p.add_argument("--min-sessions", type=int, default=5)
    p.add_argument("--min-seats", type=int, default=2)
    p.add_argument("--max-len", type=int, default=5)
    p.add_argument("--skip-repeats", action="store_true", help="leave out one command repeated in a row (exploring)")
    p.add_argument("--top", type=int, default=10)
    p.add_argument("--json", dest="out")
    p.set_defaults(func=count)

    p = sub.add_parser("outline", help="write tool outlines of a sample of sessions")
    window(p)
    p.add_argument("--sample", type=int, default=60)
    p.add_argument("--seed", type=int, default=928)
    p.add_argument("--out", required=True)
    p.set_defaults(func=outline)

    p = sub.add_parser("mark", help="mark and price a catalog on unseen sessions")
    window(p)
    p.add_argument("--catalog", required=True)
    p.add_argument("--seen", help="seen.json from outline; those sessions are left out")
    p.add_argument("--check", type=int, default=30, help="places to sample for the hand check")
    p.add_argument("--seed", type=int, default=928)
    p.add_argument("--out")
    p.set_defaults(func=mark)

    p = sub.add_parser("prices", help="print the price table as JSON")
    p.set_defaults(func=lambda a: print(json.dumps(PRICES, sort_keys=True)))

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
