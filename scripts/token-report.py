#!/usr/bin/env python3
"""
AgentX Token Usage Analyzer.
Parses Claude Code JSONL session files and AgentX usage data.
Based on github.com/kieranklaassen token analyzer pattern.

Usage:
  python3 scripts/token-report.py
  SINCE_DAYS=7 python3 scripts/token-report.py
  SINCE_DATE=2026-04-01 python3 scripts/token-report.py
"""

import json
import os
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timedelta, timezone

PROJECTS_DIR = Path.home() / ".claude" / "projects"
AGENTX_USAGE_DIR = Path(".agentx/usage")
OUTPUT_DIR = Path(".agentx/reports")

SINCE_DAYS = int(os.environ.get("SINCE_DAYS", "7")) or None
SINCE_DATE = os.environ.get("SINCE_DATE")


def get_cutoff():
    if SINCE_DATE:
        return datetime.fromisoformat(SINCE_DATE).replace(tzinfo=timezone.utc)
    if SINCE_DAYS:
        return datetime.now(timezone.utc) - timedelta(days=SINCE_DAYS)
    return None


def parse_session(jsonl_path):
    usage_total = defaultdict(int)
    prompts = []
    agent_id = None
    session_id = None
    timestamp_start = None
    subagent_count = 0

    try:
        with open(jsonl_path) as f:
            lines = f.readlines()
    except Exception:
        return None

    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        if not agent_id:
            agent_id = obj.get("agentId")
        if not session_id:
            session_id = obj.get("sessionId")

        ts = obj.get("timestamp")
        if ts and not timestamp_start:
            timestamp_start = ts

        msg_type = obj.get("type")
        if msg_type == "assistant":
            u = obj.get("message", {}).get("usage", {})
            usage_total["input"] += u.get("input_tokens", 0)
            usage_total["output"] += u.get("output_tokens", 0)
            usage_total["cache_read"] += u.get("cache_read_input_tokens", 0)
            usage_total["cache_create"] += u.get("cache_creation_input_tokens", 0)

        elif msg_type == "user":
            is_sidechain = obj.get("isSidechain", False)
            content = obj.get("message", {}).get("content", "")
            if isinstance(content, str) and content and not is_sidechain:
                prompts.append(content[:200])

    # Check subagents
    session_dir = jsonl_path.parent / jsonl_path.stem
    if session_dir.is_dir():
        subagents_dir = session_dir / "subagents"
        if subagents_dir.is_dir():
            subagent_count = len(list(subagents_dir.glob("*.jsonl")))

    total = sum(usage_total.values())
    return {
        "file": str(jsonl_path),
        "session_id": session_id or jsonl_path.stem,
        "agent_id": agent_id,
        "timestamp": timestamp_start,
        "usage": dict(usage_total),
        "total": total,
        "prompts": prompts,
        "subagents": subagent_count,
    }


def analyze_claude_sessions():
    cutoff = get_cutoff()
    projects = defaultdict(list)

    if not PROJECTS_DIR.exists():
        return projects

    for project_dir in sorted(PROJECTS_DIR.iterdir()):
        if not project_dir.is_dir():
            continue

        name = project_dir.name
        # Strip user path prefix
        for prefix in ["-Users-macbookpro-", "-home-clawd-"]:
            if name.startswith(prefix):
                name = name[len(prefix):]

        for jsonl_file in sorted(project_dir.glob("*.jsonl")):
            session = parse_session(jsonl_file)
            if not session or session["total"] == 0:
                continue

            if cutoff and session["timestamp"]:
                try:
                    ts = datetime.fromisoformat(session["timestamp"].replace("Z", "+00:00"))
                    if ts < cutoff:
                        continue
                except ValueError:
                    pass

            projects[name].append(session)

    return projects


def analyze_agentx_usage():
    """Parse AgentX's own usage tracking data."""
    if not AGENTX_USAGE_DIR.exists():
        return {}

    agents = defaultdict(lambda: {"tasks": 0, "input": 0, "output": 0, "cache_read": 0, "cache_create": 0, "duration": 0})
    cutoff = get_cutoff()

    for usage_file in sorted(AGENTX_USAGE_DIR.glob("*.json")):
        date_str = usage_file.stem
        if cutoff:
            try:
                file_date = datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc)
                if file_date < cutoff:
                    continue
            except ValueError:
                pass

        try:
            data = json.loads(usage_file.read_text())
            for agent_id, agent_data in data.get("agents", {}).items():
                a = agents[agent_id]
                a["tasks"] += agent_data.get("tasks", 0)
                a["input"] += agent_data.get("inputTokens", 0)
                a["output"] += agent_data.get("outputTokens", 0)
                a["cache_read"] += agent_data.get("cacheReadTokens", 0)
                a["cache_create"] += agent_data.get("cacheCreateTokens", 0)
                a["duration"] += agent_data.get("totalDuration", 0)
        except Exception:
            pass

    return dict(agents)


def fmt(n):
    return f"{n:,}"


def print_report(projects, agentx_usage):
    cutoff = get_cutoff()
    date_range = f"Since {cutoff.strftime('%Y-%m-%d')}" if cutoff else "All time"

    print(f"\n{'='*60}")
    print(f"  AgentX Token Usage Report")
    print(f"  {date_range}")
    print(f"{'='*60}\n")

    # AgentX tracked usage
    if agentx_usage:
        print("  AgentX Agent Usage (from daemon):\n")
        print(f"  {'Agent':<25} {'Tasks':>6} {'Input':>10} {'Output':>10} {'Cache R':>10} {'Cache W':>10} {'Total':>12}")
        print(f"  {'-'*25} {'-'*6} {'-'*10} {'-'*10} {'-'*10} {'-'*10} {'-'*12}")

        grand = {"tasks": 0, "input": 0, "output": 0, "cache_read": 0, "cache_create": 0}
        for agent_id, data in sorted(agentx_usage.items(), key=lambda x: -(x[1]["input"] + x[1]["output"])):
            total = data["input"] + data["output"] + data["cache_read"] + data["cache_create"]
            grand["tasks"] += data["tasks"]
            grand["input"] += data["input"]
            grand["output"] += data["output"]
            grand["cache_read"] += data["cache_read"]
            grand["cache_create"] += data["cache_create"]
            print(f"  {agent_id:<25} {data['tasks']:>6} {fmt(data['input']):>10} {fmt(data['output']):>10} {fmt(data['cache_read']):>10} {fmt(data['cache_create']):>10} {fmt(total):>12}")

        grand_total = grand["input"] + grand["output"] + grand["cache_read"] + grand["cache_create"]
        cache_ratio = grand["cache_read"] / (grand["cache_read"] + grand["cache_create"]) if (grand["cache_read"] + grand["cache_create"]) > 0 else 0
        print(f"  {'TOTAL':<25} {grand['tasks']:>6} {fmt(grand['input']):>10} {fmt(grand['output']):>10} {fmt(grand['cache_read']):>10} {fmt(grand['cache_create']):>10} {fmt(grand_total):>12}")
        print(f"\n  Cache hit ratio: {cache_ratio*100:.1f}%")
        print()

    # Claude Code session analysis
    if projects:
        print("  Claude Code Sessions (from JSONL):\n")
        total_sessions = 0
        total_tokens = 0

        for project_name, sessions in sorted(projects.items(), key=lambda x: -sum(s["total"] for s in x[1])):
            proj_total = sum(s["total"] for s in sessions)
            total_sessions += len(sessions)
            total_tokens += proj_total
            print(f"  {project_name}: {len(sessions)} sessions, {fmt(proj_total)} tokens")

        print(f"\n  Total: {total_sessions} sessions, {fmt(total_tokens)} tokens")
        print()

        # Top 5 expensive sessions
        all_sessions = [(p, s) for p, ss in projects.items() for s in ss]
        all_sessions.sort(key=lambda x: x[1]["total"], reverse=True)

        print("  Top 5 Expensive Sessions:\n")
        for proj, session in all_sessions[:5]:
            ts = session["timestamp"][:16] if session["timestamp"] else "?"
            prompt = session["prompts"][0][:80] if session["prompts"] else ""
            print(f"  [{ts}] {proj}: {fmt(session['total'])} tokens")
            if prompt:
                print(f"    > {prompt}")
            print()


def write_report(projects, agentx_usage):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_DIR / "token_report.md"

    lines = ["# AgentX Token Usage Report\n"]
    cutoff = get_cutoff()
    lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')} | Range: {'Since ' + cutoff.strftime('%Y-%m-%d') if cutoff else 'All time'}\n")

    if agentx_usage:
        lines.append("## Agent Usage\n")
        lines.append("| Agent | Tasks | Input | Output | Cache Read | Cache Write | Total |")
        lines.append("|-------|-------|-------|--------|------------|-------------|-------|")
        for agent_id, data in sorted(agentx_usage.items(), key=lambda x: -(x[1]["input"] + x[1]["output"])):
            total = data["input"] + data["output"] + data["cache_read"] + data["cache_create"]
            lines.append(f"| {agent_id} | {data['tasks']} | {fmt(data['input'])} | {fmt(data['output'])} | {fmt(data['cache_read'])} | {fmt(data['cache_create'])} | {fmt(total)} |")
        lines.append("")

    report_path.write_text("\n".join(lines))
    print(f"  Report: {report_path}")


def main():
    print("  Scanning...")
    projects = analyze_claude_sessions()
    agentx_usage = analyze_agentx_usage()

    print_report(projects, agentx_usage)
    write_report(projects, agentx_usage)


if __name__ == "__main__":
    main()
