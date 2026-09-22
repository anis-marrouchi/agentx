---
name: agentx-maintainer-daily
description: Run the daily context refresh and bounded triage plan for the AgentX GitHub repository, including missed-event reconciliation and release checks.
---

Load the agentx-maintainer skill and current policy. Use the shared maintenance lock. Limit the run to the daily time budget; save incomplete work for the next run.

1. Gather fresh context before any mutation. Read changed issues/PRs and relevant discussions, default-branch CI, latest release and registry metadata. Check pagination/truncation before claiming the queue is empty. Compare with previous state; do not repeat unchanged questions or failed actions without new evidence.
2. Re-rank the plan using current impact, evidence, dependencies, dates, and capacity. Verify whether apparent failures were superseded by successful runs on newer commits. If a release job is skipped, inspect why; do not publish merely to make the job green.
3. Review up to five changed threads, respecting the active-work limit. Reproduce one small high-priority issue if time permits. Prepare missing-information questions in the local digest while replies are in draft mode. Track contributor-owned work rather than taking it over.
4. Save `plan.md`, `daily.md`, and state atomically. Report only material changes, up to three human decisions, and source links. On no change, record the check and stop. During quiet hours, defer routine work; collect urgent evidence and prepare an escalation without contacting new channels.
