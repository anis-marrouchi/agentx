# Monitor — what needs you, and what doesn't

Monitor groups work into **Only you**, **Agents can handle**, **In motion**, and **Session briefings**. The first two sections show what still needs a person and what an agent could take over. “Agents can handle” means no human is needed for the task, but it does **not** mean AgentX has already automated it.

Monitor is fed by reviews of completed agent tasks and registered external CLI sessions. A task must finish and its review must succeed before findings appear. Some routine work is skipped, including successful scheduled tasks and internal workflow steps. External sessions need registration and completion hooks.

The automatic reviewer uses Claude Code on the daemon host. If **Reviews failed** rises, inspect the failed review and check that CLI's installation and sign-in. This is separate from the model used by the agent that performed the task. Reviews can consume model usage. The scripted demo disables the real reviewer and uses labelled fictional findings.

Urgency ranking depends on clients having response time settings. Without those clocks, waiting stays flat rather than becoming overdue. **Done** removes an item from the open list; **Snooze** moves it out of the immediate list. These buttons organize findings; they do not perform the underlying work.

The `agentx monitor` terminal command is hook plumbing for session reviews. It is different from this dashboard tab. For a record of ordinary agent work, open [Activity](./activity.md).

![Monitor with fictional human decisions and agent follow-ups](/screenshots/monitor-inbox.png)

*Seeded demonstration reviews. No customer work or real review model was used.*
