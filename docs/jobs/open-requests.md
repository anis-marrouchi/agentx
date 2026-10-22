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
| Done, declined, dropped | Closed. Done has a link to the proof, or the words of the check that closed it. Declined and dropped have a reason. |

A request waits on you when the agent raises a [decision card](../dashboard/approvals.md) for it, or says so with its tool. The card reminds you the usual way: the Approvals inbox, the Mac card, check-ins and the daily digest. When you answer, the request goes on. If the card expires without your answer, the request needs attention; it does not close. A card never approves itself.

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

In the dashboard, the same list is under **Approvals**, in **Open requests**. Each request is a card. What it shows is described in the next section.

### What a request's card shows

Every place that shows you a request uses the same words: its card in **Approvals**, its line on the phone app's **Desk**, the Mac card popup, and the notification when it needs attention.

- **The headline:** a few plain words that say what the request is, for example "Check the invoices batch". The agent writes it when it takes the request on. When it did not, AgentX writes it once with one short model call (`requests.headlines`). Until then, or with that setting off, the title is the start of your own words.
- **Needed from you:** the one thing the request needs from you. When nothing is needed, it says "Nothing, just so you know.". A request waiting on your answer shows the question. A request that stopped asks you to hand it back or drop it.
- **You said:** your own words, in full, below the headline. For a request you spoke, this is the transcript.
- Its state, the agent that has it, and why it is not finished.
- **Last answer from …**: what the agent last told you about it, when it answered.

A headline must say what the request is in words. One that is only a reference, such as "#412" or a link, is refused. A popup card whose title is only a reference is not shown, and its agent is told to describe the request.

## Decide on a request

On its card in the dashboard, one step each:

- **Send reply:** write your reply in the box, or press **Speak** and say it, then press **Send reply**. The agent that has the request gets your reply together with the request, within a minute, and goes on. **Speak** shows only in a browser that can turn speech into text (Chrome, Edge, Safari); it fills the box and sends nothing until you press **Send reply**.
- **Hand to agent:** pick an agent and press **Hand to agent**. Pick the same agent to make it try again, or another agent on this computer to give it the work. Text in the reply box goes along as a note. The card then shows that agent after **With**, and the request stays on the list until it is closed. Another agent does not answer in the chat where you first asked: that chat belongs to the first agent, and the new one may have no way to write there. Read its answer on the card, under **Last answer from …**. If it has a chat of its own with you, it may also write to you there.
- **Done:** closes it as finished. A link to the evidence is optional when you close it yourself.
- **Drop:** closes one you no longer want. Text in the reply box is kept as the reason.

Reply and hand-off need open requests turned on, because the daemon's check is what tells the agent.

You can also ask any agent "what is still open?". It reads the same list.

A request with several steps can be run as a workflow that AgentX follows to the end; the request then closes by itself when the workflow is done. See [Let a workflow follow a request](./follow-up-workflows.md).

## When a request needs attention

You are told once. On a Mac with the [card popup](../dashboard/approvals.md) on, the request then shows as a card that stays on screen like a decision card, when no decision card is waiting: **Hand it back**, **Drop** or **Not now**. It shows once, and only for a request that came to need attention in the last day. After that it waits in the [Approvals inbox](../dashboard/approvals.md#requests-that-are-not-finished) as a **Request**, and counts in the daily digest:

- **Yes** (or `agentx approvals approve request:<id>`) hands it back to the agent, which gets your request again and works on it. If the agent is still busy with the earlier attempt, your yes waits its turn and runs right after; the request stays in progress meanwhile. If the hand-back fails, it comes back.
- **No** (or `agentx approvals reject request:<id>`) drops it.
- **Later** puts it off.

## Close a request

- **It is finished:** `agentx requests done <id> --evidence <link>`. The link is the proof: a pull request, an issue, a message, a deploy. In the dashboard, press **Done** on the card; the link is optional there.
- **You checked it yourself:** `agentx requests done <id> --reason "checked by hand"`. This also closes a request whose check cannot tell. The proof then reads `closed by owner: checked by hand`. In the dashboard, a card with a check asks for the reason in the box next to **Done**.
- **You no longer want it:** `agentx requests drop <id>`. Add `--reason "…"` to say why.

Agents close their own requests as done or declined. When work an agent handed on comes back, it is reminded to close the request. Only you can drop one.

## Promises an agent makes

An agent often promises something to someone: "I will send the file by Friday", "I will deploy once the review is in". A **promise** is a request the agent opens itself, so the promise stays on your list until it is kept. It is the same kind of record as your own requests, and it shows in the same list.

The agent records it with its `agentx_request` tool, action `promise`:

| Field | What it holds |
|---|---|
| `owedTo` | Who it is owed to: `owner` (you), the id of another agent, or the id of a person in [people](./people.md). |
| `text` | What was promised, in one sentence. |
| `due` | Optional. When it is due, as a date such as `2030-01-31T17:00:00Z`. |
| `closeWhen` | Optional. What proves it is kept: a check, see below. |
| `home` | Optional. Where the work lives, see [Where a request landed](#where-a-request-landed). |

For example: `{action:"promise", owedTo:"client-a", text:"Send the signed contract", due:"2030-01-31T17:00:00Z"}`.

When one agent hands work to another, the hand-off itself is already followed. A promise is only for work that goes on after the answer: the agent that says "I will do it later" opens a promise owed to the agent that asked.

One agent can hold up to 200 open promises.

## Close on evidence, not on a claim

A request or a promise can carry a **check**: what proves it is finished. The agent gives it as `closeWhen`, with `promise`, `accept` or `wait`. Then:

- The daemon runs the check every 10 minutes. When the check finds the evidence, the request closes as done by itself, with the check's own words as the proof.
- When the agent says `done`, the daemon runs the check first. If the check finds the work is not finished, the agent's done is refused. If the check cannot tell (the address is down, the forge refuses to answer), the request stays open and is marked **unverified**. Saying `done` again does not count as progress: the request still shows as stalled once it has been quiet too long.
- A request without a check closes on the agent's word, as before.
- You can always close it yourself, with a reason. See [Close a request](#close-a-request).

The checks:

| Kind | Fields | Finished when |
|---|---|---|
| `url` | `url`, `contains` (optional) | The address answers with success, and holds the text when `contains` is given. |
| `issue` | `provider` (`github` or `gitlab`), `ref`, `state` (optional), `notePattern` (optional) | The issue or merge request is in that state (default `closed`; a merged one counts as closed), or one of its comments contains the text `notePattern` (plain text, upper or lower case does not matter). `ref` is `owner/repo#12`, `group/project!12` for a GitLab merge request, or the item's web address. |
| `git-ancestor` | `repo`, `commit`, `ref` (optional, default `HEAD`) | The commit is part of that branch in a local copy of the repository. `repo` is a name you set up in `requests.checkers.repos`; the agent never gives a folder. |
| `reply` | `channel`, `chatId`, `from` | The person `from` (an id from [people](./people.md)) wrote in that chat after the request was opened. |

For example: `closeWhen:{kind:"issue", provider:"github", ref:"example-org/app#12", state:"merged"}`.

The `issue` check reads through the GitHub and GitLab settings you already have (`channels.github`, `channels.gitlab`), or through `requests.checkers.github` and `requests.checkers.gitlab` when you set them. The `git-ancestor` check does not download anything: keep the local copy up to date yourself. For another computer, check the build it reports with a `url` check on its version address.

## See what is stalled

A request is **stalled** when it is past its due time, or, without a due time, when nothing has happened for a day (`--stale-hours`). One that needs attention is stalled too. Stalled requests are grouped by what they wait on:

| Group | Means |
|---|---|
| Waiting on you | It waits for your answer, or for your decision because nothing is retrying it. |
| Waiting on an agent | The agent that has it, the agent of the current step of its plan, or the agent it is owed to. |
| Waiting on an outside person | A promise owed to a person who is not you. |

To see them:

1. **Terminal:** run `agentx requests --stalled`. Each group is listed with its requests and why each one is stalled. Add `--json` for a script.
2. **Browser:** open **Approvals** and scroll to **Open requests**. Press **Stalled on you**, **Stalled on an agent** or **Stalled on an outside person** to show only that group; the number in brackets is how many it holds. **All** shows every open request again.

![Open requests showing only the promise stalled on an outside person](/screenshots/approvals/open-loops-stalled-person.png)

Each card also says who a promise is owed to, when it is due, and what check closes it, with what the check last said. A check that could not tell is shown in amber, with the reason.

![Open requests with promises, due times, checks and stalled lines](/screenshots/approvals/open-loops-all.png)

A promise past its due time comes back to you once, like a request that needs attention, with the title **Promise not kept** and the group it waits on.

## Where a request landed

When an agent takes a request on, waits on you, or closes it as done, it can say where the work lives: its **home**. One of:

| Kind | Link |
|---|---|
| `issue` | the GitLab or GitHub issue URL |
| `idea` | the idea file, e.g. `ideas/home-tv.md` |
| `approval` | the decision card id |
| `erp` | the ERP record |
| `card` | the Desk card id |

The agent passes it with `agentx_request`, e.g. `{action:"accept", home:{kind:"issue", link:"https://…/issues/394"}}`. The request shows its latest home. Every `issue`, `idea`, `approval` and `erp` home is also kept as a link of the request, so a request that moved from an idea to an issue keeps both, and `agentx requests show <id>` lists them. Two requests can share a home; the link then stays with the first one, and the second keeps it as its home.

### What did I ask today

Run `agentx requests today`. It lists every request made since 00:00 Tunis time, one row each: the time, its first words, its state, the agent that owns it, and where it landed (issue, idea, approval, ERP record, Desk card, plan, or the evidence it closed with). Requests with nowhere to land are in red, at the top. A declined or dropped request is never red. `--json` gives the same list for the Desk and for voice.

### Read the list from a script

`GET /requests` on the daemon (loopback, or a mesh token) lists requests. Without filters it gives the open ones, oldest first, at most 100. Filters, all optional:

| Filter | What it does |
|---|---|
| `state=needs_attention,waiting_owner` | Only these states. Also `open`, `closed` and `all`. |
| `closed=1` | Open and closed alike, like `state=all`. |
| `since=<epoch ms>` | Made since then, open or closed, each with its links. |
| `closedSince=<epoch ms>` | Closed since then, whenever it was made. |
| `links=1` | Each request with its links: runs, delegations, cards and homes. |
| `limit=<n>` | 1 to 500. Default 100. |
| `offset=<n>` | Page from the oldest; the reply gives `nextOffset` while there is more. |

Every reply says `total`, the number of requests that match, and `truncated: true` when it shows fewer. Without `offset`, a `since` list past its limit keeps the newest; any other list keeps the oldest.

## Requests of several steps

When a request takes two or more steps (build, deploy, check it is live, tell the client), the agent can write it as a plan. The daemon then follows each step, nudges a step that goes quiet, sends a message you approved once, and tells you at the end. See [Follow a request of several steps](./tracked-plans.md).

## Change the settings

| Command | What it does |
|---|---|
| `agentx requests settings` | Shows the settings. |
| `agentx requests settings --enabled off` | Stops recording. Open requests stay on the list. |
| `agentx requests settings --channels voice,app` | Records only on these channels. `all` goes back to every channel. A name that is not a channel a person writes on (a typo, say) is refused. |
| `agentx requests settings --from none` | Clears the list of who counts as you. |
| `agentx requests settings --stale-hours 48` | Hours without activity before a request comes back to you. Default 24. |
| `agentx requests settings --retention-days 30` | Days a closed request is kept. Default 90. |
| `agentx requests settings --checks url,issue` | The checks agents may use to close a request. Default all four: `url`, `issue`, `git-ancestor`, `reply`. `none` turns them all off; a request whose check is off is then unverified. |
| `agentx requests settings --check-every 30` | Minutes between two runs of a request's check. Default 10. |

The folders for the `git-ancestor` check are set only in `agentx.json`, as `requests.checkers.repos`: `{ "app": "/srv/app" }`.

The same settings are the `requests` block in `agentx.json`: see [Configuration: automation](../reference/config-automation.md#requests).

## Check it worked

1. **Terminal:** run `agentx requests settings`. The first line says `Requests on`.
2. Ask an agent, by voice or in the app, for something it must hand to another agent.
3. **Terminal:** run `agentx requests`. The request is listed as `waiting on another agent`, then `in progress` once the answer is back.
4. **Terminal:** run `agentx requests done <id> --evidence <link>`, then `agentx requests`. It is gone from the list.
5. **Terminal:** run `curl -s "http://127.0.0.1:18800/requests?since=$(( $(date +%s) * 1000 - 86400000 ))"`. The request is there, state `done`, with its `home` when the agent gave one.
6. Ask an agent to promise something with a check, for example: "promise me you will close issue example-org/app#12, and close it when the issue is closed".
7. **Terminal:** run `agentx requests show <id>`. It shows `Promised to owner` and `Closes when github example-org/app#12 is closed`.
8. Close the issue. Within 10 minutes, `agentx requests` no longer lists the promise, and `agentx requests show <id>` gives the check's words as the evidence.
9. **Terminal:** run `agentx requests --stalled`. It prints the stalled requests by group, or `nothing is stalled`.
10. **Terminal:** run `agentx requests today`. Each request you made since midnight is listed; the ones with no home are red, at the top.
11. **Terminal:** run `curl -s "http://127.0.0.1:18800/requests?state=needs_attention&links=1"`. Only the requests that need attention come back, each with its links.
12. Ask an agent, by voice, for something long and loosely worded. Within a few minutes, its card under **Approvals** › **Open requests** is titled with a few plain words, shows **Needed from you**, and keeps your words under **You said**. `agentx requests show <id>` shows the same `headline`.

## If something is wrong

- **`no agentx.json here`:** you are not in the install folder, the one that holds `agentx.json`. A folder inside it does not count. Go to that folder and run the command again.
- **The list says `requests are off`:** run `agentx requests settings --enabled on`.
- **A message you sent on Telegram or GitHub is not recorded:** your id on that channel is not in `from`. Add it with `--from`, as `channel:id`.
- **A request you only got an answer to is not listed:** that is expected. A request is kept only when work goes on after the answer or goes wrong.
- **A request came back as `No activity for 24 h`:** nobody closed it. Close it with `done` or `drop`, or ask the agent to carry on.
- **`home.kind must be one of …`:** the agent gave a home kind that does not exist. Use issue, idea, approval, erp or card. A declined request takes no home.
- **`a finished request needs --evidence <link>`:** add the link to the proof. From the terminal, and for agents, a request cannot be closed as done without it.
- **A message from the phone app is not recorded:** the dashboard must run from the install folder, the one that holds `agentx.json`, so it can read `.agentx/operator.key`. Start it there. A message sent through the phone app to an agent on another computer is recorded there when the computer the phone is paired with checks its own key and vouches for you to the other one. That needs three things: both computers run 0.83.1 or later, the other computer lists the first one in `mesh.peers` with the same `token` the first one sends, and the request reaches it from another machine. A token that sits only in `MESH_TOKEN`, two different tokens, or a proxy on the same machine in front of the daemon means it is not recorded.
- **You handed a request to another agent and no answer came in the chat:** that is expected. The chat where you asked belongs to the first agent. Open the request's card in the dashboard and read **Last answer from …**.
- **An agent's done is refused with `Not closed: its check says it is not finished`:** that is the check working. The request closes by itself once the evidence is there. If the check is wrong, close the request yourself with `agentx requests done <id> --reason "…"`.
- **A request is marked `unverified`:** its check could not tell. `agentx requests show <id>` says why. Common causes: the address is down, the GitHub or GitLab token is missing or cannot see the issue, the local copy of the repository does not have the commit yet (update it), or the person in a `reply` check is not in `people`. Fix the cause and wait for the next check, or close it yourself with `--reason`.
- **`no repos are set up for this check on this node`:** add the folder under `requests.checkers.repos` in `agentx.json`.
- **`the … check is turned off on this node`:** add the kind back with `agentx requests settings --checks`.
- **A card is still titled with your own words:** the agent did not describe the request and no headline could be written. The daemon log has a line `[requests] <id>: headline not written: …` with the reason. A common cause is that the engine set in `requests.headlines.provider` is not signed in on this computer. Each request is tried once per daemon start. To see the start of your words as the title on purpose, set `requests.headlines.enabled` to `false`.
- **An agent's describe is refused with `headline is only a reference`:** the headline was only an issue number, an id or a link. Say what the request is in words, and put the link in the request's `home` instead.
- **An agent says it has no `agentx_request` tool:** the tool server is added when the daemon starts with requests on. Restart the daemon. If the agent's workspace has a `.mcp.json` you wrote yourself, add the server there: `agentx serve --stdio --cwd <install folder>`.
