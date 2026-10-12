#!/usr/bin/env python3
"""
Replay prompt-cache expiry over recorded Claude Code session logs (#947).

Reads ~/.claude/projects/*/*.jsonl for a fixed date window and answers, without
calling a model: how much of each session's cost is cache writes that follow an
idle gap (the cached prefix expired, so the whole context is written again),
grouped by the gap since the previous model call in the same session.

It then prices two what-ifs in "base input token" units (cache read 0.1x,
5-minute write 1.25x, 1-hour write 2x, uncached input 1x, output not counted):

  ttl1h   every write uses the 1-hour cache, so a call 5 to 60 minutes after
          the previous one reads the prefix instead of writing it again.
  rotate  a call more than --rotate-after minutes after the previous one
          starts a fresh session carrying --brief tokens instead of the old
          context. Only the first call after the gap is repriced, so the
          later calls' smaller prefix is not counted, nor what the brief
          leaves out (and the agent may then have to read again).

Usage:
  python3 bench/cache-gap-replay.py --from 2026-10-01 --to 2026-10-07
  python3 bench/cache-gap-replay.py --from ... --to ... --rotate-after 60 --brief 8000 --json out.json

Token counts come from the logs' own usage fields, not from estimates.
"""

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path

CHANNEL_RE = re.compile(r"^Channel: ([\w:.-]+)", re.M)
GAPS = [("first call", None), ("< 5 min", 5), ("5-60 min", 60), ("1-24 h", 1440), ("> 24 h", float("inf"))]
READ, WRITE_5M, WRITE_1H = 0.1, 1.25, 2.0


def parse_time(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def gap_label(minutes):
    if minutes is None:
        return GAPS[0][0]
    for label, upper in GAPS[1:]:
        if minutes < upper:
            return label
    return GAPS[-1][0]


def calls(path, since, until):
    """Yield (channel, gap_minutes, usage, previous_context) per model call in window."""
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return
    channel, seen, last_at, last_context = "interactive", set(), None, 0
    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("isSidechain"):
            continue
        msg = obj.get("message") or {}
        content = msg.get("content")
        if obj.get("type") == "user":
            texts = [content] if isinstance(content, str) else [
                b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text"
            ]
            for text in texts:
                found = CHANNEL_RE.search(text)
                if found:
                    channel = found.group(1)
            continue
        if obj.get("type") != "assistant":
            continue
        mid, usage = msg.get("id"), msg.get("usage")
        if not mid or mid in seen or not isinstance(usage, dict):
            continue
        seen.add(mid)
        at = parse_time(obj.get("timestamp"))
        gap = (at - last_at).total_seconds() / 60 if at and last_at else None
        context = sum(usage.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        day = (obj.get("timestamp") or "")[:10]
        if since <= day <= until:
            yield channel, gap, usage, last_context
        last_at, last_context = at or last_at, context


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="since", required=True)
    ap.add_argument("--to", dest="until", required=True)
    ap.add_argument("--rotate-after", type=float, default=60, help="minutes of idle before the rotate what-if starts fresh")
    ap.add_argument("--brief", type=int, default=8000, help="tokens a rotated session starts with")
    ap.add_argument("--projects", default=str(Path.home() / ".claude" / "projects"))
    ap.add_argument("--json", dest="out")
    args = ap.parse_args()

    def bucket():
        return {"calls": 0, "input": 0, "write5m": 0, "write1h": 0, "read": 0, "output": 0,
                "cost": 0.0, "ttl1h": 0.0, "rotate": 0.0}

    by_gap, by_channel = defaultdict(bucket), defaultdict(bucket)
    for path in Path(args.projects).glob("*/*.jsonl"):
        for channel, gap, usage, previous in calls(path, args.since, args.until):
            fresh = usage.get("input_tokens") or 0
            read = usage.get("cache_read_input_tokens") or 0
            write = usage.get("cache_creation_input_tokens") or 0
            split = usage.get("cache_creation") or {}
            w1h = split.get("ephemeral_1h_input_tokens") or 0
            w5m = max(write - w1h, 0)
            cost = fresh + READ * read + WRITE_5M * w5m + WRITE_1H * w1h

            # 1-hour TTL: within an hour the prefix that was rewritten becomes a read.
            moved = min(write, previous) if gap is not None and 5 <= gap < 60 else 0
            ttl1h = fresh + READ * (read + moved) + WRITE_1H * (write - moved)

            # Rotation: after a long idle, the old prefix is replaced by a brief.
            rotate = cost
            if gap is not None and gap >= args.rotate_after and previous > args.brief:
                new_part = max(write - previous, 0) + fresh
                rotate = WRITE_5M * args.brief + new_part

            for b in (by_gap[gap_label(gap)], by_channel[channel]):
                b["calls"] += 1
                b["input"] += fresh
                b["write5m"] += w5m
                b["write1h"] += w1h
                b["read"] += read
                b["output"] += usage.get("output_tokens") or 0
                b["cost"] += cost
                b["ttl1h"] += ttl1h
                b["rotate"] += rotate

    def table(title, rows, order=None):
        total = bucket()
        for b in rows.values():
            for k in total:
                total[k] += b[k]
        names = order or sorted(rows, key=lambda n: -rows[n]["cost"])
        print(f"\n{title}")
        print(f"  {'':<16} {'calls':>7} {'write Mtok':>11} {'read Mtok':>10} {'1h writes':>9} {'cost Mu':>8} {'share':>6} {'ttl1h':>7} {'rotate':>7}")
        for name, b in [(n, rows[n]) for n in names if n in rows] + [("TOTAL", total)]:
            share = b["cost"] / total["cost"] * 100 if total["cost"] else 0
            ttl = (b["ttl1h"] / b["cost"] - 1) * 100 if b["cost"] else 0
            rot = (b["rotate"] / b["cost"] - 1) * 100 if b["cost"] else 0
            writes = b["write5m"] + b["write1h"]
            long_ttl = b["write1h"] / writes * 100 if writes else 0
            print(f"  {name[:16]:<16} {b['calls']:>7} {(b['write5m'] + b['write1h'])/1e6:>11.2f} {b['read']/1e6:>10.2f} {long_ttl:>8.0f}% "
                  f"{b['cost']/1e6:>8.2f} {share:>5.1f}% {ttl:>+6.1f}% {rot:>+6.1f}%")

    print(f"Cache gap replay {args.since}..{args.until}, rotate after {args.rotate_after:g} min with a {args.brief}-token brief")
    print("1h writes = share of cache writes already on the one-hour cache (the rest are five-minute)")
    print("cost Mu = million base-input-token units; ttl1h and rotate = change against today")
    table("By gap since the previous call in the session", by_gap, [g for g, _ in GAPS])
    table("By channel", by_channel)
    if args.out:
        Path(args.out).write_text(json.dumps({"from": args.since, "to": args.until, "rotateAfter": args.rotate_after,
                                              "brief": args.brief, "byGap": by_gap, "byChannel": by_channel}, indent=2))
        print(f"\nSaved {args.out}")


if __name__ == "__main__":
    main()
