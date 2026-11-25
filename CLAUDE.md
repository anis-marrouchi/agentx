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

## Impact Sweep Rule (Rule A, Anis 2026-11-25)

AgentX changes fast, so every PR finds and repairs what its change touched, in the same PR.

- The PR description has an **Impacted** list: every surface the change touches, from Hub pages, CLI commands, the phone and Mac apps, docs, settings, and other agents' flows (handoffs, schedules, workflows, Coder runs). Write "none" for a surface only after checking it.
- Check each listed surface in the same PR and say how (test, screenshot, command run). Do not leave a touched surface for a later PR.
- Styling must match on every Hub page: same tokens, spacing, controls and layout as the current style. A page you touch that still has the old style goes on the old-style page checklist in issue #2218, linked from the PR.
- A review fails when the Impacted list is missing or a listed surface was not checked.

## Progressive Disclosure Rule (Rule B, Anis 2026-11-25)

Simple by default; more on demand.

- Each screen, command and message shows only what most people need for the common case.
- Extra controls and details stay hidden until asked for: a chip pop-up, a hover drop-down, a "more" menu, an expandable row, or a setting switch. CLI: a short default output, detail behind a flag.
- A new control or field does not go on the default view unless the PR says why it must be always visible.
- A review fails when a change adds always-visible controls without that reason.

## Documentation Rule

Applies to every change under `docs/` and to any code change that adds or renames a feature, setting or command. Full text and screenshot tooling: [CONTRIBUTING.md › Docs conventions](CONTRIBUTING.md#docs-conventions).

- Write for a non-technical reader. Use plain words, and explain a term the first time it appears (or avoid it).
- Write procedures as numbered steps, one action per step. Label terminal and browser steps explicitly.
- Show, don't only tell: add a screenshot wherever a step touches a screen (dashboard, System Settings, a phone app). Store them under `docs/public/screenshots/<page>/`.
- A page about a flow between two people or machines opens with one diagram, built with the kit in `docs/.scripts/diagrams/` (`pnpm docs:diagrams`), never drawn by hand: [CONTRIBUTING.md › Diagrams](CONTRIBUTING.md#diagrams).
- Document everything we ship. Every feature, setting, CLI command and integration has a page or section; no setting exists only in code. A change that adds or renames a setting or command updates the docs in the same PR.
- End every page with a **Check it worked** section and an **If something is wrong** section.
- Use neutral examples only: no real company, people, agent names, hosts, IPs or tokens. Take screenshots from a demo instance, never a live fleet.
- Keep reference pages concise and validate examples against the current code.
- Run `pnpm docs:check` before submitting a documentation change.
