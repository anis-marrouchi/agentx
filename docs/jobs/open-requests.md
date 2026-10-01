# Keep track of what you asked for

You give agents requests all day. Some need more than one answer: the agent hands the work to another agent, the task runs out of time, or the computer restarts in the middle. Open requests keeps a record of each of these until someone closes it, so nothing is forgotten without you knowing.

It is off until you turn it on.

## What it records

AgentX notes every message you send to an agent. Most leave nothing behind: the agent answers and that is the end. A request stays on your list when:

- the agent hands the work to another agent,
- the task fails or runs out of time,
- a restart cuts the task off,
- or the agent says it is taking the request on (agents have a tool for this, `agentx_request`).

Each request has one state:

| State | What it means |
|---|---|
| In progress | Work is going on. |
| Waiting on you | The agent asked you a question and needs your answer. The question is shown. |
| Waiting on another agent | The work was handed on and the answer is not back yet. |
| Needs attention | The work failed, ran out of time, was cut off and not picked up again, or nothing happened for a day. |
| Done, declined, dropped | Closed. Done has a link to the proof. Declined and dropped have a reason. |

A request waits on you when the agent raises a [decision card](../dashboard/approvals.md) for it, or says so with its tool. The card reminds you the usual way: the Approvals inbox, the Mac card, check-ins and the daily digest. When you answer, the request goes on. If the card expires without your answer, the request needs attention; it does not close. The one exception is a card whose default is "approve": the work goes on.

When a request needs attention you are told once, through your normal [notifications](./notifications.md). They are held while Focus is on. After that the request stays on the list. Nothing is retried for you, and nothing closes because it got old.

## Turn it on

In the dashboard: open **Approvals**, scroll to **Open requests**, open **Settings: open requests**, tick **Record and follow my requests** and save. Or from the terminal:

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx requests settings --enabled on`.
3. Messages you speak to the Mac, type in the phone app or type in the dashboard now count as yours. They count because this computer's own surfaces vouch for them: the daemon marks the turns it starts itself, and the dashboard shows the daemon a key it keeps in `.agentx/operator.key`, next to `agentx.json`, for the phone app. A program that merely names one of those surfaces when it calls the daemon is not you.
4. Every agent on this computer gets AgentX's own tool server in its workspace at the next daemon start, so it can say what it is doing with a request and close it. A workspace whose `.mcp.json` you wrote by hand is left alone.
5. To count your messages on Telegram, WhatsApp, Slack, Discord, GitLab or GitHub too, give your id on that channel: `agentx requests settings --from telegram:123456789,github:your-login`. On GitLab and GitHub it is your login, on Telegram your numeric id, on WhatsApp your number. Telegram usernames and display names are not accepted, because the person chooses them. Each entry is `channel:id` and only applies to that channel.

Other people's messages are never recorded.

## See what is open

1. **Terminal:** run `agentx requests`.
2. You see every open request, oldest first, with when and where you asked, the agent, your words and the state.
3. For one request and what is linked to it, run `agentx requests show <id>`.

In the dashboard, the same list is under **Approvals**, in **Open requests**.

You can also ask any agent "what is still open?". It reads the same list.

## When a request needs attention

You are told once. After that it waits in the [Approvals inbox](../dashboard/approvals.md#requests-that-are-not-finished) as a **Request**, and counts in the daily digest:

- **Yes** (or `agentx approvals approve request:<id>`) hands it back to the agent, which gets your request again and works on it. If the agent is still busy with the earlier attempt, your yes waits its turn and runs right after; the request stays in progress meanwhile. If the hand-back fails, it comes back.
- **No** (or `agentx approvals reject request:<id>`) drops it.
- **Later** puts it off.

## Close a request

- **It is finished:** `agentx requests done <id> --evidence <link>`. The link is the proof: a pull request, an issue, a message, a deploy. In the dashboard, paste the link next to the request and press **Done**.
- **You no longer want it:** `agentx requests drop <id>`. Add `--reason "…"` to say why.

Agents close their own requests as done or declined. When work an agent handed on comes back, it is reminded to close the request. Only you can drop one.

## Change the settings

| Command | What it does |
|---|---|
| `agentx requests settings` | Shows the settings. |
| `agentx requests settings --enabled off` | Stops recording. Open requests stay on the list. |
| `agentx requests settings --channels voice,app` | Records only on these channels. `all` goes back to every channel. A name that is not a channel a person writes on (a typo, say) is refused. |
| `agentx requests settings --from none` | Clears the list of who counts as you. |
| `agentx requests settings --stale-hours 48` | Hours without activity before a request comes back to you. Default 24. |
| `agentx requests settings --retention-days 30` | Days a closed request is kept. Default 90. |

The same settings are the `requests` block in `agentx.json`: see [Configuration: automation](../reference/config-automation.md#requests).

## Check it worked

1. **Terminal:** run `agentx requests settings`. The first line says `Requests on`.
2. Ask an agent, by voice or in the app, for something it must hand to another agent.
3. **Terminal:** run `agentx requests`. The request is listed as `waiting on another agent`, then `in progress` once the answer is back.
4. **Terminal:** run `agentx requests done <id> --evidence <link>`, then `agentx requests`. It is gone from the list.

## If something is wrong

- **`no agentx.json here`:** you are not in the install folder, the one that holds `agentx.json`. A folder inside it does not count. Go to that folder and run the command again.
- **The list says `requests are off`:** run `agentx requests settings --enabled on`.
- **A message you sent on Telegram or GitHub is not recorded:** your id on that channel is not in `from`. Add it with `--from`, as `channel:id`.
- **A request you only got an answer to is not listed:** that is expected. A request is kept only when work goes on after the answer or goes wrong.
- **A request came back as `No activity for 24 h`:** nobody closed it. Close it with `done` or `drop`, or ask the agent to carry on.
- **`a finished request needs --evidence <link>`:** add the link to the proof. A request cannot be closed as done without it.
- **A message from the phone app is not recorded:** the dashboard must run from the install folder, the one that holds `agentx.json`, so it can read `.agentx/operator.key`. Start it there. A message sent through the phone app to an agent on another computer is not recorded on that computer either.
- **An agent says it has no `agentx_request` tool:** the tool server is added when the daemon starts with requests on. Restart the daemon. If the agent's workspace has a `.mcp.json` you wrote yourself, add the server there: `agentx serve --stdio --cwd <install folder>`.
