#!/usr/bin/env python3
"""
Small reusable workflows (#928): how much could folding repeated tool-call
slices into one call save, read from recorded Claude Code session logs.

Reads ~/.claude/projects/*/*.jsonl (main sessions only, not subagents) for a
fixed date window. No model is called and nothing is written outside --out
and --json.

  count     Find slices of consecutive tool calls that repeat across sessions
            and seats, and price the round trips they would remove.
  calls     Cost per request by its place in a session (first call, tool
            call after a message, tool call inside a chain, answer), split
            into re-read, cache write, output and input, plus how often the
            agent already groups calls in one request or one shell line.
  ahead     Look-ahead (the 10-13 comments on #928): the share of windows
            of 2 to 4 calls in a chain whose later calls use no named thing
            (path, hash, number, identifier) that first came back in a result
            inside the window, the round trips in them, and the saving if each
            such window became one call. It cannot see a decision that hangs
            on a result, so for steps fixed ahead it is an upper bound; it is
            not one for a workflow that passes values between its steps.
            --sample writes windows with the start of each result and the
            agent's text between calls, for grading whether a check on the
            result would have decided the next step.
  phases    Spend by what each request does (first call of a session, only
            reads, reads plus a test or script run, changes something,
            answer), from the tool names and the command text, and the
            stretches of 2+ reading calls in a row with the size of their
            results: what a reader on a small model could take (the 10-13
            reading design on #928). The rules are a heuristic; read them.
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
  python3 bench/slice-replay.py calls --from ... --to ...
  python3 bench/slice-replay.py ahead --from ... --to ... [--known]
  python3 bench/slice-replay.py phases --from ... --to ...
  python3 bench/slice-replay.py outline --from ... --to ... --sample 60 --out mine/
  python3 bench/slice-replay.py mark --from ... --to ... --catalog catalog.json --seen mine/seen.json --out marked/

A seat is one project folder under ~/.claude/projects (one agent workspace).
A round trip is one model request (one assistant message id); calls the model
sends in parallel share one. Folding a slice that spans requests R1..Rk into
one call removes R2..Rk. The low saving prices only what those requests
re-read from the cache; the high saving prices their whole cost.

Prices are list prices per million tokens, the table in
src/daemon/token-tracker.ts (CACHE_AWARE_PRICING); the 200k-token long-context
tier is left out. A test checks the two tables match. --prices replaces rates
per family, for example with what the runtime reports per call, which on
2026-10-13 differed from that table for Opus 5.5 (#928).
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
    found = shell_commands(command)
    return found[0] if found else "?"


def shell_commands(command):
    """Every command of a shell line, named as shell_command names the first."""
    out = []
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
        out.append(" ".join([name] + subs))
    return out


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

    Each request: {id, day, model, usage, calls: [(tool, args, use id)],
    afterMessage, prompt, results, heads, sizes, text}. sizes holds each
    result's length in bytes. heads holds the first 300
    characters of each call's result and text those of the agent's own text
    or thinking in the request. afterMessage is true when a message (not
    a tool result) came in since the request before; prompt holds the named
    things of that message and results those of each call's result, by use
    id (see named()). One assistant message is spread over several log lines
    that repeat its usage; the usage is counted once per message id."""
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return []
    order, by_id, prompt, message, owner = [], {}, set(), True, {}
    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("isSidechain") or obj.get("type") not in ("assistant", "user"):
            continue
        msg = obj.get("message") or {}
        content = msg.get("content")
        if obj.get("type") == "user":
            blocks = [b for b in (content if isinstance(content, list) else [{"type": "text", "text": content or ""}]) if isinstance(b, dict)]
            has_result = any(b.get("type") == "tool_result" for b in blocks)
            for block in blocks:
                if block.get("type") == "tool_result" and block.get("tool_use_id") in owner:
                    text = result_text(block)
                    by_id[owner[block["tool_use_id"]]]["results"][block["tool_use_id"]] = named(text)
                    by_id[owner[block["tool_use_id"]]]["heads"][block["tool_use_id"]] = head(text)
                    by_id[owner[block["tool_use_id"]]]["sizes"][block["tool_use_id"]] = len(text.encode("utf-8", "replace"))
                elif block.get("type") == "text" and block.get("text"):
                    prompt |= named(block["text"])
                    # Text sent along with tool results is a reminder, not a message.
                    message = message or not has_result
            continue
        mid = msg.get("id") or obj.get("uuid")
        if mid not in by_id:
            day = (obj.get("timestamp") or "")[:10]
            by_id[mid] = {"id": mid, "day": day, "model": msg.get("model", ""), "usage": msg.get("usage") or {}, "calls": [],
                          "afterMessage": message, "prompt": prompt, "results": {}, "heads": {}, "sizes": {}, "text": ""}
            order.append(mid)
            prompt, message = set(), False
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict) and block.get("type") in ("text", "thinking") and not by_id[mid]["text"]:
                by_id[mid]["text"] = head(block.get("text") or block.get("thinking") or "")
            if isinstance(block, dict) and block.get("type") == "tool_use":
                args = block.get("input") if isinstance(block.get("input"), dict) else {}
                by_id[mid]["calls"].append((block.get("name", "?"), args, block.get("id")))
                owner[block.get("id")] = mid
    return [r for r in (by_id[m] for m in order) if since <= r["day"] <= until and r["model"] != "<synthetic>"]


# A named thing: a path, a hash, a number of 2+ digits, or a dotted, dashed
# or underscored identifier. Used to see whether a call's arguments carry
# something that first came back in an earlier result.
NAMED_RE = re.compile(r"[\w.~-]*/[\w./~-]+|\b[0-9a-f]{7,40}\b|\b\d{2,}\b|\b[A-Za-z_]\w*[._-][\w.-]+")


def head(text, width=300):
    """The start of a result or of the agent's text, for a grader to read; never the whole of it."""
    text = " ".join(str(text).split())
    return text if len(text) <= width else text[: width - 1] + "…"


def named(text):
    return {t.strip(".-") for t in NAMED_RE.findall(text or "") if len(t.strip(".-")) >= 3}


def result_text(block):
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


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
        for name, args, _ in r["calls"]:
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

def repeated(calls, max_len, min_sessions, min_seats, skip_repeats):
    """Label sequences of 2..max_len calls seen in enough sessions and seats."""
    seen = defaultdict(lambda: (set(), set()))
    for (seat, sid), cs in calls.items():
        labels = [c[0] for c in cs]
        for n in range(2, max_len + 1):
            for i in range(len(labels) - n + 1):
                gram = tuple(labels[i: i + n])
                if skip_repeats and len(set(gram)) == 1:
                    continue
                seen[gram][0].add(sid)
                seen[gram][1].add(seat)
    return {g for g, (ss, seats) in seen.items() if len(ss) >= min_sessions and len(seats) >= min_seats}


def count(args):
    sessions = load_all(args.projects, args.since, args.until)
    total_spend = spend(sessions)
    calls = {k: flatten(v, args.level) for k, v in sessions.items()}
    tool_requests = sum(1 for v in sessions.values() for r in v if r["calls"])
    n_calls = sum(len(v) for v in calls.values())
    keep = repeated(calls, args.max_len, args.min_sessions, args.min_seats, args.skip_repeats)

    # Mark each session greedily, longest pattern first, without overlap.
    covered_calls, low, high = 0, 0.0, 0.0
    per_gram = defaultdict(lambda: {"places": 0, "calls": 0, "low": 0.0, "high": 0.0})
    for key, cs in calls.items():
        labels, used = [c[0] for c in cs], [False] * len(cs)
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


# ---- calls -----------------------------------------------------------------

def place(i, r):
    if i == 0:
        return "first"
    if not r["calls"]:
        return "answer"
    return "afterMessage" if r["afterMessage"] else "chain"


def chains(requests):
    """Chain number per request: a run of requests with tool calls and no message between."""
    out, n = [], -1
    for i, r in enumerate(requests):
        if r["calls"] and (i == 0 or r["afterMessage"] or not requests[i - 1]["calls"]):
            n += 1
        out.append(n if r["calls"] else None)
    return out


def calls_report(args):
    sessions = load_all(args.projects, args.since, args.until)
    total_spend = spend(sessions)
    keys = ("cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens", "input_tokens")
    rows = defaultdict(lambda: {"requests": 0, "cost": 0.0, **{k: 0 for k in keys}, "reread": 0.0, "write": 0.0, "output": 0.0, "input": 0.0})
    multi_requests = multi_calls = tool_calls = shell = shell2 = shell3 = 0
    chain_len = defaultdict(int)
    for (seat, sid), requests in sessions.items():
        for i, (r, c) in enumerate(zip(requests, chains(requests))):
            b = rows[place(i, r)]
            p = PRICES[family(r["model"])]
            u = r["usage"]
            b["requests"] += 1
            b["cost"] += cost(r["model"], u)[0]
            for k in keys:
                b[k] += u.get(k, 0)
            b["reread"] += u.get("cache_read_input_tokens", 0) / 1e6 * p["cacheRead"]
            b["write"] += u.get("cache_creation_input_tokens", 0) / 1e6 * p["cacheCreate"]
            b["output"] += u.get("output_tokens", 0) / 1e6 * p["output"]
            b["input"] += u.get("input_tokens", 0) / 1e6 * p["input"]
            tool_calls += len(r["calls"])
            if len(r["calls"]) > 1:
                multi_requests += 1
                multi_calls += len(r["calls"])
            if c is not None:
                chain_len[(sid, c)] += len(r["calls"])
            for name, a, _ in r["calls"]:
                if name == "Bash":
                    parts = [s for s in SPLIT_RE.split(a.get("command", "")) if s.strip()]
                    shell += 1
                    shell2 += len(parts) >= 2
                    shell3 += len(parts) >= 3

    pct = lambda x, d: round(x / d * 100, 1) if d else 0.0
    lengths = sorted(chain_len.values())
    result = {
        "from": args.since, "to": args.until, "sessions": len(sessions), "spendUsd": round(total_spend, 4),
        "byPlace": {}, "toolCalls": tool_calls, "chains": len(lengths), "medianChainCalls": lengths[len(lengths) // 2] if lengths else 0,
        "callsInMultiToolRequests": pct(multi_calls, tool_calls), "callsPerMultiToolRequest": round(multi_calls / multi_requests, 1) if multi_requests else 0.0,
        "shellJoining2Plus": pct(shell2, shell), "shellJoining3Plus": pct(shell3, shell),
    }
    print(f"Calls {args.since}..{args.until}: {len(sessions)} main sessions, {total_spend:.2f} USD")
    print(f"  {'place':<13} {'requests':>8} {'read':>8} {'written':>8} {'output':>7} {'cost':>7} {'share':>6}   re-read  write  output  input")
    for name in ("first", "afterMessage", "chain", "answer"):
        b = rows.get(name)
        if not b or not b["requests"]:
            continue
        n = b["requests"]
        result["byPlace"][name] = {
            "requests": n, "avgCacheRead": round(b["cache_read_input_tokens"] / n), "avgCacheWrite": round(b["cache_creation_input_tokens"] / n),
            "avgOutput": round(b["output_tokens"] / n), "avgCostUsd": round(b["cost"] / n, 4), "sharePct": pct(b["cost"], total_spend),
            "parts": {k: pct(b[k], b["cost"]) for k in ("reread", "write", "output", "input")},
        }
        e = result["byPlace"][name]
        print(f"  {name:<13} {n:>8} {e['avgCacheRead']/1e3:>7.1f}k {e['avgCacheWrite']/1e3:>7.1f}k {e['avgOutput']:>7} {e['avgCostUsd']:>7.3f} {e['sharePct']:>5.1f}%"
              f"   {e['parts']['reread']:>6.0f}% {e['parts']['write']:>5.0f}% {e['parts']['output']:>6.0f}% {e['parts']['input']:>5.0f}%")
    print(f"\n  {tool_calls} tool calls in {len(lengths)} chains, {result['medianChainCalls']} calls per chain at the median")
    print(f"  {result['callsInMultiToolRequests']}% of tool calls share a request with others ({result['callsPerMultiToolRequest']} per such request)")
    print(f"  {result['shellJoining2Plus']}% of shell calls join 2+ commands, {result['shellJoining3Plus']}% 3+")
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2))
        print(f"\nSaved {args.out}")


# ---- ahead -----------------------------------------------------------------

def first_from_result(requests):
    """{named thing: index (in session call order) of the call whose result first carried it}."""
    seen, first, k = set(), {}, 0
    for r in requests:
        seen |= r["prompt"]
        start = k
        for _, a, _ in r["calls"]:
            seen |= named(json.dumps(a))
            k += 1
        for j, (_, _, use) in enumerate(r["calls"]):
            for t in r["results"].get(use, ()):
                if t not in seen:
                    first[t] = start + j
            seen |= r["results"].get(use, set())
    return first


def window_record(key, requests, flat, i, k):
    """One window for a grader: each call with the start of its result, and the agent's text between calls."""
    first, last = flat[i][3], flat[i + k - 1][3]
    steps = []
    for c in flat[i: i + k]:
        r = requests[c[3]]
        use = next((u for name, a, u in r["calls"] if label(name, a, "command") == c[0] and arg_shape(name, a) == c[1]), None)
        steps.append({"call": f"{c[0]}  {c[1]}", "result": r["heads"].get(use, "")})
    return {"seat": key[0], "session": key[1], "removedRequests": last - first, "steps": steps,
            "between": [requests[j]["text"] for j in range(first + 1, last + 1) if requests[j]["text"]]}


def ahead(args):
    """Look-ahead: windows of calls whose arguments use nothing new from results inside the window."""
    sessions = load_all(args.projects, args.since, args.until)
    total_spend = spend(sessions)
    labelled = {k: flatten(v, "command") for k, v in sessions.items()}
    known = repeated(labelled, args.max_len, args.min_sessions, args.min_seats, False) if args.known else None
    windows = defaultdict(lambda: [0, 0])
    low = high = nowrite = 0.0
    removed, picked = 0, []
    for key, requests in sessions.items():
        flat = labelled[key]
        req = [c[3] for c in flat]
        per_request = chains(requests)
        chain = [per_request[i] for i in req]
        argtok = [named(json.dumps(a)) for r in requests for _, a, _ in r["calls"]]
        first = first_from_result(requests)

        def fixed(i, k):
            if i + k > len(flat) or chain[i + k - 1] != chain[i]:
                return None
            for j in range(i + 1, i + k):
                for t in argtok[j]:
                    a = first.get(t)
                    if a is not None and i <= a < j and req[a] < req[j]:
                        return False
            return True

        for i in range(len(flat)):
            for k in range(2, args.max_len + 1):
                ok = fixed(i, k)
                if ok is None:
                    break
                windows[k][0] += 1
                windows[k][1] += ok
        i = 0
        while i < len(flat):
            for k in range(args.max_len, 1, -1):
                if fixed(i, k) and (known is None or tuple(c[0] for c in flat[i: i + k]) in known):
                    whole, reread = removed_cost(requests, req[i], req[i + k - 1])
                    low += reread
                    high += whole
                    removed += req[i + k - 1] - req[i]
                    if args.sample:
                        picked.append(window_record(key, requests, flat, i, k))
                    # The results still come back and are written to the cache; only re-reads and output go.
                    for r in requests[req[i] + 1: req[i + k - 1] + 1]:
                        p = PRICES[family(r["model"])]
                        nowrite += r["usage"].get("cache_read_input_tokens", 0) / 1e6 * p["cacheRead"] + r["usage"].get("output_tokens", 0) / 1e6 * p["output"]
                    i += k
                    break
            else:
                i += 1

    pct = lambda x, d: round(x / d * 100, 1) if d else 0.0
    result = {
        "from": args.since, "to": args.until, "sessions": len(sessions), "spendUsd": round(total_spend, 4), "maxLen": args.max_len,
        "known": bool(args.known), "byLength": {str(k): {"windows": w, "fixed": f, "fixedPct": pct(f, w)} for k, (w, f) in sorted(windows.items())},
        "savingLowPct": round(low / total_spend * 100, 2) if total_spend else 0.0, "savingHighPct": round(high / total_spend * 100, 2) if total_spend else 0.0,
        "savingNoWritePct": round(nowrite / total_spend * 100, 2) if total_spend else 0.0,
        "removableRequests": removed,
    }
    print(f"Look-ahead {args.since}..{args.until}: {len(sessions)} main sessions, {total_spend:.2f} USD")
    for k, b in result["byLength"].items():
        print(f"  {k} steps: {b['fixed']} of {b['windows']} windows ({b['fixedPct']}%) use nothing new from a result inside the window")
    where = f"only sequences seen in {args.min_sessions}+ sessions and {args.min_seats}+ seats" if args.known else f"any window of up to {args.max_len} calls"
    print(f"  saving, {where}: {result['savingLowPct']}% (re-reads only) to {result['savingHighPct']}% (whole cost) of spend;"
          f" {result['savingNoWritePct']}% if the results are still written to the cache")
    print(f"  {removed} round trips sit in such windows")
    if args.sample:
        out = Path(args.sample_out)
        out.mkdir(parents=True, exist_ok=True)
        sample = random.Random(args.seed).sample(picked, min(args.sample, len(picked)))
        (out / "windows.jsonl").write_text("".join(json.dumps(w) + "\n" for w in sample))
        print(f"  wrote {len(sample)} of {len(picked)} windows to {out}/windows.jsonl for grading")
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2))
        print(f"\nSaved {args.out}")


# ---- phases ----------------------------------------------------------------

# What a call does, from the tool name and the command text. A request takes
# the strongest kind among its calls: change > run > read.
CHANGE_RE = re.compile(
    r"\bgit\s+(commit|push|merge|rebase|reset|tag|cherry-pick)\b|\bgh\s+(pr|issue|release|repo)\s+(create|merge|comment|close|edit|review|reopen|delete)\b"
    r"|\bgh\s+api\b.*-X\s*(POST|PATCH|PUT|DELETE)|\bcurl\b.*-X\s*(POST|PATCH|PUT|DELETE)|\b(rm|mv|cp|mkdir|chmod|ln|tee)\s"
    r"|\b(npm|pnpm)\s+publish\b|\bdocker\s+(push|run|compose\s+up)\b|\bkubectl\s+(apply|delete|rollout|scale)\b|\bsystemctl\s+(start|stop|restart)\b|\bdeploy\b|[^>&0-9]>{1,2}\s*(?!/dev/null)[\w/~.]")
# Programs that run something, matched at the start of a command: 'pnpm test', 'python3', 'make'.
RUN_RE = re.compile(r"^(node|python3?|tsx|ts-node|make|pytest|vitest|jest|tsc|bash|sh|deno|bun|ruby|php"
                    r"|cargo (test|run|build|bench)|go (test|run|build)|(npm|pnpm|yarn|npx) \S+)$")
CHANGE_MCP_RE = re.compile(r"(create|update|delete|merge|write|send|post|comment|push|add|set|close|edit|remove|reply)", re.I)


def call_kind(name, args):
    if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return "change"
    if name == "Bash":
        command = args.get("command", "")
        if CHANGE_RE.search(command):
            return "change"
        return "run" if any(RUN_RE.match(c) for c in shell_commands(command)) else "read"
    if name.startswith("mcp__"):
        return "change" if CHANGE_MCP_RE.search(name.split("__")[-1]) else "read"
    if name in ("Task", "Agent"):
        return "run"
    return "read"


def request_kind(i, r):
    if i == 0:
        return "first"
    if not r["calls"]:
        return "answer"
    kinds = {call_kind(name, a) for name, a, _ in r["calls"]}
    return "change" if "change" in kinds else "run" if "run" in kinds else "read"


def phases(args):
    """Spend by what each call does, and the stretches of reading a cheaper reader could take."""
    sessions = load_all(args.projects, args.since, args.until)
    total_spend = spend(sessions)
    rows = defaultdict(lambda: {"requests": 0, "cost": 0.0})
    stretches, stretch_calls, stretch_bytes, stretch_cost = 0, 0, 0, 0.0
    for requests in sessions.values():
        run_calls = run_bytes = 0
        run_cost = 0.0
        prev_chain = None
        per_request = chains(requests)

        def close():
            nonlocal stretches, stretch_calls, stretch_bytes, stretch_cost
            if run_calls >= args.min_calls:
                stretches += 1
                stretch_calls += run_calls
                stretch_bytes += run_bytes
                stretch_cost += run_cost

        for i, r in enumerate(requests):
            kind = request_kind(i, r)
            c = cost(r["model"], r["usage"])[0]
            rows[kind]["requests"] += 1
            rows[kind]["cost"] += c
            # A stretch: requests in a row, in one chain, that only read.
            if kind == "read" and per_request[i] == prev_chain:
                run_calls += len(r["calls"])
                run_bytes += sum(r["sizes"].values())
                run_cost += c
            else:
                close()
                run_calls, run_bytes, run_cost = (len(r["calls"]), sum(r["sizes"].values()), c) if kind == "read" else (0, 0, 0.0)
            prev_chain = per_request[i]
        close()

    pct = lambda x: round(x / total_spend * 100, 1) if total_spend else 0.0
    result = {
        "from": args.since, "to": args.until, "sessions": len(sessions), "spendUsd": round(total_spend, 4),
        "byKind": {k: {"requests": rows[k]["requests"], "costUsd": round(rows[k]["cost"], 4), "sharePct": pct(rows[k]["cost"])}
                   for k in ("first", "read", "run", "change", "answer") if k in rows},
        "readingStretches": {"minCalls": args.min_calls, "stretches": stretches, "calls": stretch_calls,
                             "resultTokens": stretch_bytes // 4, "costUsd": round(stretch_cost, 4), "sharePct": pct(stretch_cost)},
    }
    print(f"Phases {args.since}..{args.until}: {len(sessions)} main sessions, {total_spend:.2f} USD")
    names = {"first": "first call of a session", "read": "only reads", "run": "reads plus a test or script run",
             "change": "changes something", "answer": "answer, no tool"}
    for k, b in result["byKind"].items():
        print(f"  {names[k]:<32} {b['requests']:>6} requests {b['sharePct']:>5.1f}%")
    st = result["readingStretches"]
    print(f"\n  {st['stretches']} reading stretches of {args.min_calls}+ calls: {st['calls']} calls, results about {st['resultTokens'] / 1e6:.2f}M tokens,"
          f" {st['sharePct']}% of spend in their requests")
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
        for name, a, _ in r["calls"]:
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
        p.add_argument("--prices", help="JSON file of {family: {input, output, cacheRead, cacheCreate}} to use in place of the built-in table")

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

    p = sub.add_parser("calls", help="cost per call by its place in a session, and how calls are grouped")
    window(p)
    p.add_argument("--json", dest="out")
    p.set_defaults(func=calls_report)

    p = sub.add_parser("ahead", help="ceiling on how many coming calls can be fixed without seeing results")
    window(p)
    p.add_argument("--max-len", type=int, default=4)
    p.add_argument("--known", action="store_true", help="only count sequences seen in --min-sessions and --min-seats")
    p.add_argument("--min-sessions", type=int, default=5)
    p.add_argument("--min-seats", type=int, default=2)
    p.add_argument("--sample", type=int, default=0, help="windows to write for grading")
    p.add_argument("--sample-out", default="ahead-windows")
    p.add_argument("--seed", type=int, default=928)
    p.add_argument("--json", dest="out")
    p.set_defaults(func=ahead)

    p = sub.add_parser("phases", help="spend by what each call does, and the reading stretches in it")
    window(p)
    p.add_argument("--min-calls", type=int, default=2, help="calls a reading stretch needs")
    p.add_argument("--json", dest="out")
    p.set_defaults(func=phases)

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
    if getattr(args, "prices", None):
        for fam, rates in json.loads(Path(args.prices).read_text()).items():
            if fam not in PRICES:
                raise SystemExit(f"--prices: unknown family {fam}; known: {', '.join(sorted(PRICES))}")
            PRICES[fam] = {**PRICES[fam], **rates}
    args.func(args)


if __name__ == "__main__":
    main()
