---
name: agentx-maintainer-weekly
description: Review the AgentX support backlog, contribution flow, installation quality, and release process weekly, and replace the next week's maintenance plan using current evidence.
---

Load the agentx-maintainer skill and current policy. Acquire the shared lock and gather fresh context before reviewing the prior seven days. Do not merely repeat the daily digest.

Within the weekly budget:
- Identify recurring setup/Settings failures and missing diagnostics; propose the smallest documentation or product fix that removes repeated support work.
- Review oldest untriaged reports, contributor wait time, blocked PRs, flaky CI, and released versus unpublished changes. Label measurements as partial when source history is incomplete. Never invent response-time metrics.
- Inspect package smoke results on Linux/macOS and note coverage gaps in upgrades, native desktop permissions, provider access, and load testing.
- Select at most three outcomes for the coming week, with evidence, acceptance criteria, dependencies, proposed owners, and review dates. Revisit RBAC use cases without promising an implementation date.
- Propose well-scoped `help wanted` / `good first issue` candidates. Never mass-create issues or close stale reports.

Write `weekly.md` and replace the current plan while preserving unfinished decisions and evidence. Routine public announcements remain drafts under the policy. Scheduling cadence stays fixed; priorities and actions change from the evidence gathered each run.
