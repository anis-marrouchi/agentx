# Org: who reports to whom, and what each agent is doing

Your org chart lists who reports to whom: you and other people, and your agents. The [Wall](./wall.md)'s **Org** page draws it from the top down, with what each agent is doing now. Select **Org** in the Wall's nav to open it; [See the org chart](./wall.md#see-the-org-chart) explains each part.

![The Wall's Org page: the owner at the top, the assistant under them, then a writer and a project manager, with a support lead and an engineer under the project manager](/screenshots/wall/org.png)

Pausing an agent, and approving an agent that another agent created, are still done on the classic **Org** page at `/org`. Open it under **Dashboard pages**. To change who reports to whom, use the Wall's **Edit org** button. When an agent creates another agent, the new one does not start on its own. It waits in [Approvals](./approvals.md) until you say yes.

## Draw your org chart

The chart comes from `business.orgChart` in `agentx.json`. Until you fill it in, every agent is listed under **Not in the org chart**.

The easiest way to fill it in is the Wall's [Set up the org](./wall.md#set-up-the-org) page: pick members from lists, give them roles, and add who reports to whom, people included. The steps below do the same for agents from the terminal.

1. **Terminal:** in the folder with `agentx.json`, give each agent a role, and a boss for every agent but the top one. `assistant`, `pm` and `dev` are examples; use your agents' IDs:

   ```sh
   agentx business orgchart add assistant --role "Chief of staff"
   agentx business orgchart add pm --role "Project manager" --reports-to assistant
   agentx business orgchart add dev --role Engineer --reports-to pm
   ```

2. **Browser:** open the dashboard and click the **Org** tab (or go to `/org`).

The role shows under the agent's name. On the classic page, the line under it is the first sentence of the role's first responsibility in `business.roles`, or else of the agent's instructions. An org chart needs nothing else: `business.enabled` can stay off.

## People and kinds of relation

A link between two members of the chart is a **relation**. A member is written `agent:<id>` for an agent in the org chart, or `person:<id>` for a person in `people`. There are three kinds:

| Kind | What it means | Rule |
|---|---|---|
| `reports-to` | The line manager. | One per member, and no loops. When an agent is stuck, the problem goes up this line between agents, and stops before a person. |
| `dotted-line` | A second manager for one topic or project. | As many as you like. Never used to pass a problem up. |
| `acts-for` | The agent works on behalf of this person. | From an agent to a person only. |

The `--reports-to` of `agentx business orgchart add` is a `reports-to` relation, so charts you already have keep working.

1. **Terminal:** check the person is in `people` with `agentx people list`. `sam` and `kim` are examples; use your own IDs.
2. **Terminal:** make a person the boss of your top agent:

   ```sh
   agentx business relation add agent:assistant reports-to person:sam
   ```

3. **Terminal:** add a second manager, or say whom an agent works for:

   ```sh
   agentx business relation add agent:dev dotted-line person:kim
   agentx business relation add agent:assistant acts-for person:sam
   ```

   A relation that names someone unknown, or breaks a rule above, is refused and nothing is saved.

4. **Terminal:** list every relation with `agentx business relation list`, and remove one with `agentx business relation remove <from> <type> <to>`.
5. **Terminal:** run `agentx daemon restart` if the business layer is on, so it reads the new chart.
6. **Browser:** on the Wall, select **Org**, then **Refresh**. A person sits in the chart with the agents that report to them under them. A **dotted-line** shows as **dotted line to** *name* on the card, and as a dashed arrow with **Show dotted lines**. An **acts-for** shows as **acts for** *name* on the agent's card.
7. **Browser:** on the classic page at `/org`, a person's card says **Person** and has no Pause button; the agents that report to that person sit under it. Under an agent's job, its card lists **Dotted line to …** and **Acts for …**.

   ![The Org tab with a person at the top; the assistant under them acts for them, and an engineer further down has a dotted line to a second person](/screenshots/org/people.png)

The relations are saved under `business.relations` in `agentx.json`; see the [configuration reference](../reference/config-operations.md#business).

## What each card shows on the classic page

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

1. **Browser:** on the Wall, select **Org**. Each member of `business.orgChart`, and each person a relation names, is a card one row under its boss, joined to it by a solid line. On the classic page at `/org`, each agent is a card under its boss.
2. Click **Pause** on a card. It says **Paused by the owner**, and a message to that agent is answered with "is paused by the owner".
3. Click **Resume**. The card says **Idle** again.

## If something is wrong

- **The Wall's Org page says "Something in the org chart does not hold":** a link names someone who is not in `people` or `business.orgChart`, a member has two bosses, or the bosses loop. The message names the member. Fix it in `agentx.json`.
- **Every agent is under "Not in the org chart":** `business.orgChart` is empty. Run `agentx business orgchart add` for each agent (see above).
- **An agent sits at the top although it has a boss:** its boss is not an agent or person here, or the two report to each other. Check with `agentx business relation list`.
- **A yellow box above the chart says "Problem in the org relations":** a relation names someone who is not in `people` or `business.orgChart`, or breaks a rule. `agentx business relation list` shows the same problem; fix it with `remove`. With the business layer on, the daemon starts without it until it is fixed, and its log says `[business] initialization failed:` with the same problem.
- **A person's agents do not escalate to them:** that is by design. A problem goes up `reports-to` only between agents, and stops before a person.
- **Every card says "Status unknown":** the daemon is not running, or the dashboard cannot reach it. Run `agentx daemon status`.
- **`agentx business orgchart add` ran, but saving any setting now fails with `business.mainChannel: Required`:** you turned `business.enabled` on. The business layer needs a chat to post to; set `business.mainChannel`, or turn it off again.
- **A new agent still does nothing after your yes:** it was added while the daemon was running. Run `agentx daemon restart`.
- **"Only the owner can pause an agent":** the command ran inside an agent's terminal. Run it from your own terminal, or use the Org page.
