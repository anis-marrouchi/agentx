---
name: agentx-maintainer
description: Triage issues, contributor work, and release health for anis-marrouchi/agentx. Use for this repository's GitHub events and maintenance planning, not other repositories assigned to Coder.
---

Read `.github/maintainer/TRIAGE.md` and `POLICY.json` in the AgentX checkout before acting. They define authority, communication limits, priority, durable state, and concurrency rules.

Start with fresh context using `node scripts/maintainer-context.mjs`; compare with `.agentx/maintainer/plan.md`. Create the directory if absent. On first use, make a plan before taking external actions. Verify the actual default branch and published npm version; a green release workflow alone does not prove registry availability.

For event runs, inspect the referenced thread and current CI, update priority and the plan, then take at most one useful bounded next action. Select daily or weekly skill for scheduled runs. Re-read policy on each invocation; never copy changing task lists into cron instructions. If the checkout is behind the remote, report this and inspect the remote runbook before acting; never reset a dirty checkout.
