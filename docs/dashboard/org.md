# Org: who reports to whom, and what each agent is doing

**Org** draws your agents as an org chart: each agent with its role, who it reports to, its job in one line, and what it is doing now. From an agent's card you open its activity, or pause it until you resume it.

When an agent creates another agent, the new one does not start on its own. It waits in [Approvals](./approvals.md) until you say yes.

![The Org tab: the assistant at the top, a content writer waiting for approval and a project manager under it, and under the project manager a paused engineer and an idle support desk](/screenshots/org/tree.png)

## Draw your org chart

The chart comes from `business.orgChart` in `agentx.json`. Until you fill it in, every agent is listed under **Not in the org chart**.

1. **Terminal:** in the folder with `agentx.json`, give each agent a role, and a boss for every agent but the top one. `assistant`, `pm` and `dev` are examples; use your agents' IDs:

   ```sh
   agentx business orgchart add assistant --role "Chief of staff"
   agentx business orgchart add pm --role "Project manager" --reports-to assistant
   agentx business orgchart add dev --role Engineer --reports-to pm
   ```

2. **Browser:** open the dashboard and click the **Org** tab (or go to `/org`).

The role shows under the agent's name. The line under it is the first sentence of the role's first responsibility in `business.roles`, or else of the agent's instructions. An org chart needs nothing else: `business.enabled` can stay off.

## What each card shows

| Status | What it means |
|---|---|
| **Idle** | The agent is loaded and runs nothing now. |
| **Working** | It is running a task (**Working on 2** when it runs more than one). |
| **Paused by the owner** | You paused it. It starts nothing until you resume it. |
| **Waits for your approval (created by …)** | Another agent created it. It starts nothing until you say yes in Approvals. |
| **Status unknown** | The daemon did not answer, so the page cannot tell working from idle. |

Each card has **Activity** (the agent's history), **Agent page**, and **Pause** or **Resume**. The page refreshes every 15 seconds.

## Pause or resume an agent

1. **Browser:** on the agent's card, click **Pause**. The card says **Paused by the owner**.
2. To start it again, click **Resume**.

From the terminal: `agentx agent pause <id>` and `agentx agent resume <id>`.

A paused agent refuses every new message, schedule and task, with a line saying it is paused. A run that had already started finishes. Pausing and resuming apply at once, with no restart.

## Approve an agent that another agent created

An agent that runs `agentx agent add`, `agentx team add` or `agentx team import` from its own terminal creates agents that wait for you:

1. You get an item in [Approvals](./approvals.md): **New agent "…", created by …**, with its workspace and its instructions.
2. Click **Yes** to let it run, or **No** to remove it, and the schedules that came with it, from `agentx.json`. Its folder is kept.
3. If it was added while the daemon was running, run `agentx daemon restart` after your yes, so the daemon loads it.

From the terminal: `agentx approvals approve agent:<id>` or `agentx approvals reject agent:<id>`. Only you can decide: an agent that runs these commands, or `agentx agent pause` and `resume`, is refused.

This is a guard, not a lock. An agent that edits `agentx.json` by hand is not caught by it. To keep agents from changing the configuration at all, limit what their tools may write; see [SECURITY.md](https://github.com/anis-marrouchi/agentx/blob/main/SECURITY.md).

## Check it worked

1. **Browser:** open **Org**. Each agent in `business.orgChart` is a card under its boss.
2. Click **Pause** on a card. It says **Paused by the owner**, and a message to that agent is answered with "is paused by the owner".
3. Click **Resume**. The card says **Idle** again.

## If something is wrong

- **Every agent is under "Not in the org chart":** `business.orgChart` is empty. Run `agentx business orgchart add` for each agent (see above).
- **An agent sits at the top although it has a boss:** its boss is not an agent here, or the two report to each other. Check with `agentx business orgchart list`.
- **Every card says "Status unknown":** the daemon is not running, or the dashboard cannot reach it. Run `agentx daemon status`.
- **`agentx business orgchart add` ran, but saving any setting now fails with `business.mainChannel: Required`:** you turned `business.enabled` on. The business layer needs a chat to post to; set `business.mainChannel`, or turn it off again.
- **A new agent still does nothing after your yes:** it was added while the daemon was running. Run `agentx daemon restart`.
- **"Only the owner can pause an agent":** the command ran inside an agent's terminal. Run it from your own terminal, or use the Org page.
