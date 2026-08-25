# AgentX Development Context

## Current Goal

Build a mesh-level operations dashboard that makes automation and agent activity manageable across all AgentX nodes.

## Constraints

- Preserve the existing zero-build dashboard stack: server-rendered HTML, shared tokens, and vanilla browser JavaScript.
- Treat persisted cron run files as the source of truth for run status; scheduler counters reset on reload.
- Cron jobs inherit their agent's execution tier. Keep any per-job `model` override aligned with that agent when migrating runtimes.
- Reuse the existing fleet snapshot, task pages, agent pages, and peer discovery rather than adding parallel models.
- Keep the overview compact. Use progressive disclosure for prompts, summaries, errors, skills, and session details.
- Support keyboard, mobile, dark/light themes, unreachable nodes, and partial fleet failures.

## Delivery Phases

1. Mesh overview: fleet posture, ongoing activity provenance, today's cron outcomes, agent/skill inventory.
2. Management: disable/archive obsolete schedules, compare skills, and expose stale automation signals.
3. Correlation: stable root task/session IDs across mesh hops, traces, workflows, and native provider sessions.

## Known Risks

- Cron attempts do not yet carry a stable task/trace/session join ID.
- Mesh forwarding lacks a canonical root activity ID.
- Full cron responses can contain sensitive content; list APIs must return bounded summaries.
