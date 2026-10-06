# Monitor — what needs you, and what doesn't

Monitor groups work into **Only you**, **Agents can handle**, **In motion**, and **Session briefings**:

- **Only you** lists what needs a person: a decision, an approval, or something the system can't know.
- **Agents can handle** lists work that doesn't need a person. It does **not** mean AgentX already does it automatically.
- **In motion** shows runs that are still going.
- **Session briefings** are the short summaries each finished task leaves behind.

![Monitor with fictional human decisions and agent follow-ups](/screenshots/monitor-inbox.png)

*Seeded demonstration reviews. No customer work or real review model was used.*

## Where the items come from

After an agent finishes a task, AgentX reviews it and writes down what is left to do. An item appears only once the task has finished and its review has succeeded. Some routine work is never reviewed, such as successful scheduled jobs and internal workflow steps. Work done in a separate terminal tool (for example a Claude Code session outside AgentX) only appears if that tool is set up to report its sessions to AgentX.

The review runs with Claude Code on the machine that runs the daemon (the AgentX background service). This is separate from the model the agent itself used, and reviews can use paid model usage:

- It uses the account Claude Code is signed in to on that machine, never the `ANTHROPIC_API_KEY` in your `.env` file.
- It uses the `opus` model by default. To use a cheaper one, set `AGENTX_MONITOR_MODEL` in the `.env` file next to `agentx.json`, for example `AGENTX_MONITOR_MODEL=sonnet`, then restart the daemon.
- Without Claude Code on that machine (the Docker image doesn't include it by default), every review fails and costs nothing. Your agents keep working, but Monitor shows no new items, and **Reviews failed** goes up with the reason `Reviewer failed: claude CLI not found on the daemon PATH`.
- There is no setting to turn the reviewer off. Only the scripted demo skips it; it uses labelled fictional items instead.

See [Understand model costs](../help/costs.md#monitor-s-reviewer) for what the reviewer costs.

## Handle what needs you

![The Only you section with Done and Snooze buttons](/screenshots/monitor-only-you.png)

1. **Browser:** open the dashboard and select the **Monitor** tab.
2. Read the first card under **Only you**.
3. To see why it was raised, select **Evidence** under the card.
4. Do the work itself, outside Monitor (reply to the client, approve the change, and so on).
5. Select **Done**. The card leaves the open list.

To deal with a card later, select **Snooze** instead. The card moves out of the immediate list; select **Bring back** to return it. **Clear all** marks every open card done, on every machine. These buttons only organise the list. They never do the underlying work.

Each card shows how long it has been waiting. If you have set how quickly a client expects an answer, the time is marked **rising**, then **past the clock** when that time is up. Without such a setting, waiting time stays **flat**.

## Hand work to an agent

![The Agents can handle section](/screenshots/monitor-agents-handle.png)

1. **Browser:** scroll to **Agents can handle**.
2. Read a card and decide whether an agent should take it.
3. Ask the agent to do it, for example from [in-page chat](./chat.md) or the channel you normally use.
4. Select **Done** on the card once the work is handed over.

The `agentx monitor` terminal command is something else: it connects external terminal sessions to these reviews. For a record of ordinary agent work, open [Activity](./activity.md).

## Check it worked

1. **Browser:** open **Monitor**. The strip at the top shows **Nodes reporting**, **Awaiting review**, **Reviews failed** and **Recent briefings**.
2. **Nodes reporting** shows every machine you expect, for example `1 / 1`.
3. After an agent finishes a task, **Awaiting review** goes up, then back down, and a new briefing appears.
4. Select **Done** on a card. It disappears and stays gone after you reload the page.

## If something is wrong

- **Reviews failed goes up:** the reviewer couldn't run. To see why, select **Failed** under **Session briefings** and read the reason on a card. Then fix it:
  1. **Terminal:** on the daemon's machine, run `claude --version` to check Claude Code is installed. If the reason is `claude CLI not found on the daemon PATH`, install it, or leave it: Monitor then stays empty, and nothing is charged.
  2. **Terminal:** run `claude` once and sign in, if it asks you to.
  3. **Browser:** select **Retry** on a failed card. It turns into a briefing once the review succeeds.
- **Nothing ever appears:** the task may still be running, or it was routine work that isn't reviewed (such as a successful scheduled job). Check [Activity](./activity.md) to confirm the task finished.
- **A machine is listed as not reporting:** its daemon or the connection to it is down. See [Add a second machine](../jobs/second-machine.md).
- **Nothing ever becomes "past the clock":** no response time is set for that client, so waiting stays flat.
