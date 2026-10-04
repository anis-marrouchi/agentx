#!/usr/bin/env python3
"""
Replay ObservationPack over recorded Claude Code session logs.

Reads ~/.claude/projects/*/*.jsonl for a fixed date window and answers, without
calling a model: how many tool-result bytes would the pack have withheld, from
which tools, on which channel, and how many later requests re-read them.

Usage:
  python3 bench/observation-pack-replay.py --from 2026-10-01 --to 2026-10-03
  python3 bench/observation-pack-replay.py --from ... --to ... --limit 10240 --head 1024 --tail 1024 --json out.json

The token figure is an estimate (bytes / 4). It counts a withheld byte once per
later request in the same session, which is what a cached prefix re-reads.
"""

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

CHANNEL_RE = re.compile(r"^Channel: ([\w:.-]+)", re.M)


def result_bytes(block):
    content = block.get("content")
    if isinstance(content, str):
        return len(content.encode("utf-8", "replace"))
    if isinstance(content, list):
        return sum(
            len(part.get("text", "").encode("utf-8", "replace"))
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return 0


def tool_group(name):
    if name.startswith("mcp__agentx__"):
        return "agentx tools"
    if name.startswith("mcp__"):
        return "other MCP"
    return name


def replay(path, since, until):
    """Yield (channel, tool, bytes, later_requests) per tool result in window."""
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return
    names, channel, results, requests, seen = {}, "interactive", [], 0, set()
    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("isSidechain"):
            continue
        msg = obj.get("message") or {}
        content = msg.get("content")
        if obj.get("type") == "assistant":
            mid = msg.get("id")
            if mid and mid not in seen:
                seen.add(mid)
                requests += 1
            for block in content if isinstance(content, list) else []:
                if block.get("type") == "tool_use":
                    names[block.get("id")] = block.get("name", "?")
        elif obj.get("type") == "user":
            if isinstance(content, str):
                found = CHANNEL_RE.search(content)
                if found:
                    channel = found.group(1)
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text":
                    found = CHANNEL_RE.search(block.get("text", ""))
                    if found:
                        channel = found.group(1)
                if block.get("type") != "tool_result":
                    continue
                day = (obj.get("timestamp") or "")[:10]
                if not (since <= day <= until):
                    continue
                results.append((channel, tool_group(names.get(block.get("tool_use_id"), "?")), result_bytes(block), requests))
    for channel, tool, size, at in results:
        yield channel, tool, size, max(requests - at, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="since", required=True)
    ap.add_argument("--to", dest="until", required=True)
    ap.add_argument("--limit", type=int, default=10240)
    ap.add_argument("--head", type=int, default=1024)
    ap.add_argument("--tail", type=int, default=1024)
    ap.add_argument("--projects", default=str(Path.home() / ".claude" / "projects"))
    ap.add_argument("--json", dest="out")
    args = ap.parse_args()
    keep = args.head + args.tail

    def bucket():
        return {"results": 0, "bytes": 0, "packed": 0, "packedBytes": 0, "withheldBytes": 0, "rereadTokens": 0, "withheldRereadTokens": 0}

    by_tool, by_channel = defaultdict(bucket), defaultdict(bucket)
    for path in Path(args.projects).glob("*/*.jsonl"):
        for channel, tool, size, later in replay(path, args.since, args.until):
            for b in (by_tool[tool], by_channel[channel]):
                b["results"] += 1
                b["bytes"] += size
                b["rereadTokens"] += size // 4 * later
                if size > args.limit:
                    b["packed"] += 1
                    b["packedBytes"] += size
                    b["withheldBytes"] += size - keep
                    b["withheldRereadTokens"] += (size - keep) // 4 * later

    def table(title, rows):
        total = bucket()
        for b in rows.values():
            for k in total:
                total[k] += b[k]
        print(f"\n{title}")
        print(f"  {'':<16} {'results':>8} {'MB':>8} {'over limit':>10} {'MB over':>8} {'share':>6} {'reread Mtok':>12} {'withheld Mtok':>14} {'cut':>5}")
        for name, b in sorted(rows.items(), key=lambda kv: -kv[1]["withheldRereadTokens"]) + [("TOTAL", total)]:
            share = b["packedBytes"] / total["bytes"] * 100 if total["bytes"] else 0
            cut = b["withheldRereadTokens"] / b["rereadTokens"] * 100 if b["rereadTokens"] else 0
            print(f"  {name[:16]:<16} {b['results']:>8} {b['bytes']/1e6:>8.1f} {b['packed']:>10} {b['packedBytes']/1e6:>8.1f} {share:>5.1f}% {b['rereadTokens']/1e6:>12.1f} {b['withheldRereadTokens']/1e6:>14.1f} {cut:>4.0f}%")

    print(f"ObservationPack replay {args.since}..{args.until}, limit {args.limit} B, keep {keep} B")
    table("By tool", by_tool)
    table("By channel", by_channel)
    if args.out:
        Path(args.out).write_text(json.dumps({"from": args.since, "to": args.until, "limit": args.limit, "keep": keep, "byTool": by_tool, "byChannel": by_channel}, indent=2))
        print(f"\nSaved {args.out}")


if __name__ == "__main__":
    main()
