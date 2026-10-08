# Configuration: automation

The settings in `agentx.json` that make agents work on their own: schedules, services, incoming webhooks, workflows, learned procedures, notifications, approvals, open requests, request status, resuming after a restart and due reminders. For the other sections and how to edit the file, see the [Configuration reference](./config.md).

"Default" is the value used when the key is left out. "required" means the entry is rejected without it; "—" means it is unset unless you set it.

## `crons`

Schedules (also called scheduled jobs, cron jobs or routines), keyed by job id: `crons.<id>`. Each job either asks an agent to run a prompt or runs a shell command.

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns the job on or off without deleting it. |
| `schedule` | string | required | When the job runs, as a cron expression such as `0 7 * * 1`. |
| `timezone` | string | `"UTC"` | The timezone the `schedule` is read in, for example `Europe/Paris`. |
| `agent` | string | required | The agent that runs the prompt. For a command job, the agent told when it fails. |
| `prompt` | string | `""` | What the agent is asked to do. A job needs a `prompt` or a `command`. |
| `command` | string | — | A shell command run directly instead of an agent: no model, no tokens. |
| `timeout` | number | `600` | Time limit in seconds. Agent jobs get at least 2 hours; see [time limits](./config.md#time-limits-and-cancel). |
| `model` | string | — | Model for this job only, instead of the agent's model. |
| `maxOutputTokens` | number (50–8000) | — | Asks the agent to keep its answer under about this many tokens. A soft cap added to the prompt. |
| `autonomy` | `"report"` \| `"propose"` \| `"act"` | — (acts as `act`) | How much the run may do. See [routine autonomy](./config.md#routine-autonomy). Not allowed on command jobs. |
| `onError` | `"log"` \| `"notify"` \| `"disable"`, or a list of them | `"log"` | What happens when a run fails: log it, send a message, or turn the job off after 3 failures in a row. From the second failure in a row a message is sent anyway. |
| `notify` | object | — | Where this job's messages go: the answer from each successful run, and failure messages. |
| `notify.channel` | string | required | Channel for the job's messages, for example `telegram`. |
| `notify.chatId` | string | required | The chat on that channel. |
| `notify.accountId` | string | — | Which account on that channel, when you have more than one. |
| `deliverResult` | boolean | `true` | Sends the answer from each successful run to `notify`. Set `false` to send only failure messages there. Has no effect without `notify`. |
| `fireToken` | string | — | Secret that lets another system start the job now. See [fire a routine](/jobs/fire-a-routine). |
| `createdBy` | string | — | The agent that created the job from chat. Set by AgentX; an agent may only manage jobs it created, unless it is an admin. |
| `approval` | object | — | A change an agent asked for that waits for you. Set by AgentX; cleared by `agentx schedule approve` or `agentx schedule reject`. |
| `approval.action` | `"create"` \| `"delete"` | required | What the agent asked for. A job waiting on `create` never runs. |
| `approval.requestedBy` | string | required | The agent that asked. |
| `approval.requestedAt` | string | required | When it asked (date and time). |

```json
"crons": {
  "weekly-summary": {
    "schedule": "0 8 * * 1",
    "timezone": "UTC",
    "agent": "writer",
    "prompt": "Summarise last week's merged changes",
    "onError": ["notify", "disable"],
    "notify": { "channel": "telegram", "chatId": "123456789" }
  }
}
```

## `wikiNotes`

Notes agents leave for the wiki observe/sweep run: what changed, the source and the date. The listed schedules read them first and record each one as patched, rejected or deferred. Off by default. Guide: [Let agents leave notes for the wiki run](/jobs/wiki-notes).

| Key | Type | Default | What it does |
|---|---|---|---|
| `wikiNotes.enabled` | boolean | `false` | Turns wiki notes on for this node. Needs `wikiNotes.inbox`. |
| `wikiNotes.inbox` | string | — | Agent that runs the wiki observe/sweep schedule. Notes are kept on its node; other nodes forward theirs to it. |
| `wikiNotes.crons` | string[] | `[]` | Schedule ids (keys of `crons`) that read the inbox when they start. Each must run as the inbox agent. |
| `wikiNotes.maxNotesPerRun` | number (1-100) | `20` | Most notes one run is given, open notes before deferred ones. The rest wait for the next run. |
| `wikiNotes.maxDeferrals` | number (1-20) | `3` | A note deferred this many times expires and is no longer offered. |

```json
{
  "wikiNotes": { "enabled": true, "inbox": "wiki-agent", "crons": ["wiki-sweep"] }
}
```

## `services`

Services answer a known kind of message with a fixed prompt, keyed by service id: `services.<id>`. When an incoming message matches a trigger, the service's prompt is sent to its agent.

| Key | Type | Default | What it does |
|---|---|---|---|
| `name` | string | required | Name shown in lists and logs. |
| `triggers` | list of objects | required | Patterns that start the service. |
| `pattern` | string | required | A trigger's regular expression, matched against the message text, ignoring case. |
| `channel` | string | — | Limits a trigger to one channel, for example `whatsapp`. |
| `allowedContacts` | list of strings | — | Only these senders can start the service. Unset: anyone. |
| `agent` | string | required | The agent that runs the prompt. |
| `prompt` | string | required | The prompt sent to the agent when a trigger matches. |
| `schedule` | string | — | A cron expression kept with the service. The daemon does not run services on a schedule yet; use `crons` for timed work. |
| `timezone` | string | `"UTC"` | Timezone for `schedule`. |
| `notify` | object | — | A destination kept with the service (`channel`, `chatId`, `notify.accountId`). Not used by the daemon yet. |

## `webhooks`

The list of incoming webhooks, as managed on the dashboard's Webhooks tab. The address a system posts to is always `/webhook/<agentId>/<source>` on the daemon.

| Key | Type | Default | What it does |
|---|---|---|---|
| `id` | string | required | Short name for the entry: lowercase letters, digits, `-` and `_`. |
| `source` | string | required | The sending system, for example `github`, `gitlab` or `stripe`. |
| `agentId` | string | required | The agent that handles the event. |
| `secretEnv` | string | — | Name of the environment variable that holds the signing secret. When set, unsigned or wrongly signed requests are refused. |
| `description` | string | — | A note for people reading the list. |
| `enabled` | boolean | `true` | A disabled entry is ignored. |
| `node` | string | — | Sends the event to this mesh peer instead of running it on this machine. |
| `triggers` | map of strings | — | Starts a different workflow per event type. Keys are event types such as `issues.opened` or `Merge Request Hook`; values are workflow ids. |
| `defaultWorkflow` | string | — | Workflow started when no `triggers` key matches. Unset: the agent handles the event itself. |

```json
"webhooks": [
  { "id": "repo-events", "source": "github", "agentId": "reviewer", "secretEnv": "GITHUB_WEBHOOK_SECRET",
    "triggers": { "pull_request.opened": "review-pr" } }
]
```

## `workflows`

The workflow engine. See [Workflows](/dashboard/workflows).

| Key | Type | Default | What it does |
|---|---|---|---|
| `workflows.enabled` | boolean | `false` | Turns the workflow engine on. |
| `workflows.dir` | string | `".agentx/workflows"` | Folder that holds workflow definitions. |
| `workflows.n8n` | object | `{"baseUrl":"","apiKey":""}` | Connects your n8n instance so the builder can list its workflows as steps. |
| `workflows.n8n.baseUrl` | string | `""` | Address of your n8n instance. Empty: not connected. |
| `workflows.n8n.apiKey` | string | `""` | n8n API key. Use an environment reference such as `${N8N_API_KEY}`. |
| `workflows.matching` | object | `{}` | Matching incoming messages to a workflow. |
| `workflows.matching.enabled` | boolean | `false` | Checks each message for a matching workflow. |
| `workflows.matching.mode` | `"suggest"` \| `"auto"` | `"suggest"` | `suggest` only logs a match; `auto` runs the workflow instead of the agent. |
| `workflows.matching.autoRunThreshold` | number (0–1) | `0.85` | In `auto` mode, how confident a match must be to run the workflow. |
| `workflows.matching.suggestThreshold` | number (0–1) | `0.65` | How confident a match must be to count at all. Also how close a saved workflow must be before an agent is told it fits a request (follow-up workflows). |
| `workflows.followUp` | object | `{}` | Workflows that agents start for your requests and AgentX follows to the end. See [Let a workflow follow a request](/jobs/follow-up-workflows). |
| `workflows.followUp.enabled` | boolean | `true` | Agents may start follow-up workflows, and are told when a saved workflow fits a request. Needs `workflows.enabled`. |
| `workflows.followUp.agents` | object | `{}` | Per agent, by id: `false` turns follow-up workflows off for that agent. |
| `workflows.followUp.stallMinutes` | number | `30` | Minutes without progress before an agent step gets a reminder (a nudge). At most 10080 (7 days). |
| `workflows.followUp.maxNudges` | integer (0–20) | `2` | Nudges before the step counts as blocked and you are told. |
| `workflows.followUp.approval` | `"step"` \| `"start"` | `"step"` | When you approve messages to people: each before it is sent, or all at once when a run starts. A workflow's own `approval` wins. |
| `workflows.editor` | `"disabled"` \| `"readonly"` \| `"edit"` | `"edit"` | The dashboard's workflow editor: hidden, view only, or editable. |

## `procedures`

Procedures are step-by-step guides AgentX learns from work that repeats. When the extraction job runs is set by the `procedure-extract` entry in `crons`, which `agentx procedure watch` writes.

| Key | Type | Default | What it does |
|---|---|---|---|
| `procedures.enabled` | boolean | `true` | Turns procedures on. |
| `procedures.dir` | string | `".agentx/procedures"` | Folder that holds procedures. |
| `procedures.extraction` | object | `{}` | Settings for finding new procedures. |
| `procedures.extraction.enabled` | boolean | `false` | Turns finding new procedures on. |
| `procedures.extraction.onTaskCompletion` | boolean | `false` | Counts repeated patterns after each finished task. Uses no model. |
| `procedures.extraction.minOccurrences` | number (2 or more) | `3` | How often a pattern must repeat before it becomes a draft. |
| `procedures.extraction.sinceDays` | number (1 or more) | `7` | How many days of past work to look at. |
| `procedures.extraction.maxClusters` | number (1 or more) | `5` | Most drafts made in one run. |
| `procedures.extraction.via` | string | — | Agent whose session writes the drafts. |
| `procedures.injection` | object | `{}` | Giving procedures to agents. |
| `procedures.injection.enabled` | boolean | `true` | Adds matching procedures to a new agent conversation as guidance. |
| `procedures.injection.maxProcedures` | number (1 or more) | `2` | Most procedures added at once. |
| `procedures.injection.minScore` | number (0–1) | `0.5` | How closely a procedure must match the request to be added. |

## `notifications`

Messages about finished, failed or long tasks. See [get notified](/jobs/notifications).

| Key | Type | Default | What it does |
|---|---|---|---|
| `notifications.longTaskThreshold` | number | `30` | Seconds a task must run before you are told about it. `0` turns this off. |
| `notifications.destination` | object | — | Where task messages go. Unset: no task messages. |
| `notifications.destination.channel` | string | required | Channel, for example `telegram` or `push`. |
| `notifications.destination.chatId` | string | required | The chat on that channel. |
| `notifications.destination.accountId` | string | — | Which account on that channel. |
| `notifications.channel` | string | — | Where `agentx notify` and messages held during Focus go when no channel is given, for example `push` or `ntfy`. Unset: `push` when `channels.push.enabled` is on, otherwise `ntfy`. |
| `notifications.on` | object | `{}` | Which events send a message. |
| `notifications.on.taskComplete` | boolean | `true` | A long task finished. |
| `notifications.on.taskError` | boolean | `true` | A task failed. |
| `notifications.on.taskQueued` | boolean | `false` | A task had to wait in the queue. |
| `notifications.local` | object | `{}` | What `agentx notify` does on this Mac. macOS only. |
| `notifications.local.banner` | boolean | `true` | Shows a desktop banner. |
| `notifications.local.sound` | boolean | `true` | Plays a sound. |
| `notifications.local.soundName` | string | `"Glass"` | A sound from `/System/Library/Sounds`, without the extension. |
| `notifications.local.volume` | number (0–1) | `0.4` | Sound volume. |
| `notifications.local.icon` | string | — | Image for the banner icon (`.png`, `.jpg` or `.icns`). Unset: the AgentX logo. Applied by `agentx desktop install`. |

## `calls`

Agents ringing you for a live voice call on AgentX Voice. See [Calls from your agents](/dashboard/calls). The same settings cover an agent asking to see through your phone camera ([Share your phone camera](/dashboard/mobile-camera#when-an-agent-asks-to-see)): a camera ask counts as a call here.

| Key | Type | Default | What it does |
|---|---|---|---|
| `calls.allow` | string[] | `[]` | Agents that may call you, or ask to see: ids, or `"*"` for every agent. Empty: nobody. |
| `calls.maxPerHour` | number (1–60) | `3` | Most calls and camera asks one agent may place in an hour, together. |
| `calls.ringSeconds` | number (10–300) | `45` | Seconds a call rings, or a camera ask waits on the phone, before it counts as missed. |
| `calls.maxCallMinutes` | number (1–240) | `30` | An answered call nobody hung up ends after this many minutes (the widget quit or crashed, the Mac slept), so the agent can call again. |
| `calls.ringSound` | string | `"Submarine"` | The ring: a sound from `/System/Library/Sounds`, without the extension. |
| `calls.summary` | boolean | `true` | After hang-up, the agent writes a short summary, filed in the dashboard's Ask history. |

## `approvals`

The Approvals inbox. See [Approvals](/dashboard/approvals#settings).

| Key | Type | Default | What it does |
|---|---|---|---|
| `approvals.defaultExpiryDays` | number (up to 365) | `3` | Days a decision card waits when the agent gave no expiry. |
| `approvals.maxExpiryDays` | number (up to 365) | `30` | The longest any card may wait. |
| `approvals.laterHours` | number (up to 720) | `24` | Hours **Later** hides an item. |
| `approvals.notifyAgent` | boolean | `true` | Tells the agent that raised a card when it is decided or expires. |
| `approvals.forwardTo` | string | — | The name of a machine in `mesh.peers` whose inbox and popup take the cards agents on this machine raise. The answer comes back to the agent here. Unset: cards stay on this machine. See [Agents on another machine](/dashboard/approvals#agents-on-another-machine). |
| `approvals.digest` | object | `{}` | One reminder a day of what is waiting. |
| `approvals.digest.enabled` | boolean | `true` | Sends the daily reminder. |
| `approvals.digest.time` | string | `"09:00"` | Time of day, 24-hour `HH:MM`. |
| `approvals.digest.timezone` | string | — | Timezone for `time`, for example `Europe/Paris`. Unset: this machine's. |
| `approvals.digest.destination` | object | — | Where the reminder goes. Unset: `notifications.destination`. |
| `approvals.digest.destination.channel` | string | required | Channel for the reminder. |
| `approvals.digest.destination.chatId` | string | required | The chat on that channel. |
| `approvals.digest.destination.accountId` | string | — | Which account on that channel. |
| `approvals.popup` | object | `{}` | Shows waiting cards on this Mac. macOS only. See [Answer from a card on your Mac](/dashboard/approvals#answer-from-a-card-on-your-mac). |
| `approvals.popup.enabled` | boolean | `false` | Shows waiting cards on this Mac. |
| `approvals.popup.style` | `"card"` \| `"dialog"` | `"card"` | `"card"`: the web card window. `"dialog"`: plain macOS dialogs, also the fallback when the window can't open. |
| `approvals.popup.theme` | `"system"` \| `"light"` \| `"dark"` | `"system"` | The card's colours. `"system"` follows light or dark mode. |
| `approvals.popup.speak` | boolean | `true` | Speaks one short line when the card opens. |
| `approvals.popup.voice` | string | — | A macOS voice for the spoken line. Unset: the system voice. |
| `approvals.popup.sound` | string | `"chime"` | `"chime"` (the card's soft chime), a sound from `/System/Library/Sounds` such as `"Glass"`, or `""` for none. |
| `approvals.popup.volume` | number (0 to 1) | `0.4` | Sound volume. |
| `approvals.popup.timeoutSeconds` | number (10 to 3600) | `600` | How long the card waits for an answer. After that the card stays in the inbox. |
| `approvals.checkin` | object | `{}` | Check-ins: waiting cards and your open Apple Reminders on the Mac card, a few times a day. macOS only. See [Check-ins](/dashboard/approvals#check-ins-a-few-times-a-day). |
| `approvals.checkin.enabled` | boolean | `false` | Runs check-ins. |
| `approvals.checkin.dailyAt` | string (`HH:MM`) | `"09:00"` | The daily check-in: every open reminder. |
| `approvals.checkin.times` | string[] (`HH:MM`) | `["11:00", "14:00", "17:00"]` | The other check-ins: reminders due soon. |
| `approvals.checkin.timezone` | string | — | IANA time zone for the times. Unset: this machine's. |
| `approvals.checkin.lists` | string[] | `["Reminders"]` | Your Reminders lists to look at. |
| `approvals.checkin.agent` | string | — | The agent that writes cards for reminders without an `agentx:` line. Unset: those reminders are skipped. |
| `approvals.checkin.dueWithinHours` | number | `24` | A normal check-in takes reminders due within this many hours, or overdue. |
| `approvals.checkin.maxAsksPerPass` | number (1 to 20) | `5` | Most agents one check-in asks to write a card, whatever they answer. |
| `approvals.checkin.composeTimeoutSeconds` | number (30 to 3600) | `300` | How long an agent may take to write one card, counted from the start of its turn. The turn is stopped at the limit. |

## `requests`

Open requests: what you asked an agent for is recorded and followed until it is done, declined or dropped. Off by default.

When it is on, AgentX notes every message you send to an agent. A message the agent simply answers leaves nothing behind. A request is kept open when its work goes on after the answer, or goes wrong:

- The agent handed the work to another agent.
- The run failed or hit its time limit.
- A restart cut the run off.

An open request that fails, times out, is cut off and not picked up again, or has no activity for `staleAfterHours` is marked as needing attention. You are told once, through your normal notifications, which are held while Focus is on. Nothing is retried for you, and nothing closes by getting old.

Who counts as you on this computer's own surfaces (voice, the phone app, the dashboard) is proven, not declared: the daemon marks the turns it starts itself, and the dashboard presents the key in `.agentx/operator.key` for the phone app. The daemon creates that file next to `agentx.json` at start, readable by your user only. A call to `POST /task` that names one of those channels without the key runs as an ordinary turn and is not recorded as your request. When the phone app talks to an agent on another computer, the computer it is paired with checks its own key on the forward and tells the other one the turn is yours; that other computer believes it only from a request that carries one of its `mesh.peers[].token` values and comes from another machine, never from a caller on the same machine or a bare header. A computer you let vouch is trusted for more than the list: the turn is yours for [people limits](/jobs/people) too. When the whole mesh shares one token, every computer in it can vouch, so share a token only between computers you own.

While requests are on, or follow-up workflows are (`workflows.enabled` and `workflows.followUp.enabled`), the daemon adds its own tool server (`agentx serve --stdio`) to every agent's `.mcp.json` at start, as `agentx`, so each agent can close its requests with the `agentx_request` tool. An `agentx` entry you declared in the agent's `mcp` block, or a `.mcp.json` you wrote by hand, wins. Agents on a `claude-code` engine do not depend on that file: every session the daemon starts for them loads the `agentx` tool server through its own start flags, so the `agentx_request` and `agentx_approval` tools are there whether or not requests are on.

How to see, close and drop requests, step by step: [Keep track of what you asked for](/jobs/open-requests).

To turn it on by hand:

1. Open `agentx.json`.
2. Add `"requests": { "enabled": true }`.
3. To count your messages on a channel other people can also write on (Telegram, WhatsApp, Slack, Discord, GitLab, GitHub), add your id on that channel to `from`, as `channel:id`: your login on GitLab and GitHub, your numeric id on Telegram, your number on WhatsApp. For example `"from": ["telegram:123456789", "github:your-login"]`.
4. Save the file. The running daemon picks the change up; no restart is needed.

| Key | Type | Default | What it does |
|---|---|---|---|
| `requests.enabled` | boolean | `false` | Records and follows your requests. |
| `requests.channels` | list of strings | `[]` | Channels to record on. Empty: every channel a person writes on (`telegram`, `whatsapp`, `slack`, `discord`, `gitlab`, `github`, `app`, `voice`, `dashboard`, `webrtc`). |
| `requests.from` | list of strings | `[]` | Who counts as you on channels other people can reach: your id on that channel, as `channel:id`. That is your login on GitLab and GitHub, and the sender id everywhere else (the numeric id on Telegram, the number on WhatsApp). An entry only applies to its own channel. Usernames beside an id and display names are not matched, because the person chooses them. Empty: only this machine's own surfaces count (`voice`, `app`, `dashboard`, `webrtc`). |
| `requests.staleAfterHours` | number (up to 8760) | `24` | Hours without activity before an open request comes back to you. |
| `requests.retentionDays` | number (up to 3650) | `90` | Days a closed request is kept before it is deleted. Open requests are never deleted. |
| `requests.plans` | object | `{}` | Tracked plans: a request of two or more steps, each with an owner agent, followed until every step is done. Needs `requests.enabled`. See [Follow a request of several steps](/jobs/tracked-plans). |
| `requests.plans.enabled` | boolean | `true` | Agents may make plans, and the daemon follows them. |
| `requests.plans.stallMinutes` | number (up to 10080) | `30` | Minutes without progress before a step's agent is nudged. |
| `requests.plans.maxNudges` | whole number (0 to 20) | `3` | Nudges per step before it counts as blocked and you are told. |
| `requests.plans.approveKinds` | list of strings | `["message"]` | Step kinds you approve once, on a decision card, when the plan is made. An approved `message` step is sent by the daemon without asking again. |
| `requests.plans.disabledAgents` | list of strings | `[]` | Agents that may not make a plan. |

## `requestStatus`

Request status: a person who asks an agent for work in a GitLab or GitHub thread sees the state of that request in the same thread. Off by default. It works on its own; `requests.enabled` does not have to be on.

When it is on for a channel, AgentX posts one comment for each request and edits that same comment as the work moves. It is never posted twice. The comment shows one of these states:

| State | When |
|---|---|
| Queued | The agent is busy with an earlier message in the same thread. |
| Working | The agent's turn started. |
| Waiting on *agent* | The agent handed the work to another agent and waits for its answer. |
| Waiting on an answer from the owner | The agent raised a decision card and waits for it. The comment does not show the question. |
| Done | The turn ended and nothing it handed out is still open. |
| Failed | The turn, or work it handed out, ended with an error. Also a queued message whose turn could not start. |
| Timed out | The turn, or work it handed out, hit its time limit, or a decision card expired without an answer. |
| Stopped | Someone stopped the run. |
| Cut off by a restart | A restart stopped the run and it was not picked up again. Written after the daemon is back. |

The comment names the agent that was asked, the state, the time (UTC) and, while waiting, the agent the work waits on. It never shows an error text, a file path, a machine name or anything about other requests.

Every event that starts a turn in an issue, a merge request or a pull request gets a status comment: a comment from a person, and also an assignment or a newly opened issue or pull request. An event with no thread to comment on, such as a pipeline or a push, gets none.

When the comment cannot be written (the token is refused, the issue was deleted), AgentX tries again once a minute and stops after five failed tries. It tries once more each time the state changes.

While it is on for GitLab, an agent that is assigned an issue or a merge request is no longer asked to write its own acknowledgement comment: the status comment is the acknowledgement.

To turn it on:

1. Open a terminal in the folder that holds `agentx.json`.
2. Run `agentx request-status gitlab on` (or `github`). The running daemon picks the change up; no restart is needed.
3. Or, in the browser: **Settings › Channels**, open **GitLab** or **GitHub**, and switch **Request status** on.

| Key | Type | Default | What it does |
|---|---|---|---|
| `requestStatus.channels` | list of strings | `[]` | Channels that show request status: `gitlab`, `github`. Empty: off. Ended requests are forgotten after `requests.retentionDays`. |

In a mesh, an edit is made with the same agent account that wrote the comment. When that account's token lives on another machine, the edit is sent there; that machine must run a version that has request status, or the comment stays at its first state.

## `shutdown`

How a daemon stop treats tasks that are still running. See [restart without losing work](/jobs/restart-safely#change-how-long-it-waits).

| Key | Type | Default | What it does |
|---|---|---|---|
| `shutdown.drainTimeoutSeconds` | number (0–86400) | — | How long a stop waits for running tasks before stopping them. Unset: `AGENTX_DRAIN_TIMEOUT_MS` from `.env`, else 300. An agent's own `drainTimeoutSeconds` can make the wait longer. Keep the service's stop time above it. |
| `shutdown.restart.allowBy` | string (regular expression) | — | Who may ask for "restart when idle" right away, matched against the request's `by` (for example `^(operator\|restart-window)`). Requests from anyone else are held until `window`, or refused when there is no window. Unset: anyone. |
| `shutdown.restart.window` | string `HH:MM` (local time) | — | When held requests start their wait for an idle moment. |
| `shutdown.restart.windowWaitMinutes` | number (1–1440) | `180` | How long that wait lasts before it gives up without restarting. |
| `shutdown.restart.forbidOnTimeoutRestart` | boolean | `false` | Turns every request into an idle-only one: a wait that runs out gives up instead of restarting over running work. |

## `resume`

What happens to work a restart cut off. Chat messages are picked up again in their chat; schedules never are, because their next run covers them. See [restart without losing work](/jobs/restart-safely).

| Key | Type | Default | What it does |
|---|---|---|---|
| `resume.enabled` | boolean | `true` | Picks up cut-off work after a restart. |
| `resume.maxAgeMinutes` | number (1 or more) | `30` | Work older than this is reported, not picked up. |
| `resume.maxAttempts` | number | `1` | How many times a run is picked up again if it keeps getting cut off. |
| `resume.reportOnlyChannels` | list of strings | `[]` | Channels whose runs are only reported, even from a chat. |
| `resume.directChannels` | list of strings | `[]` | Other channels (voice, webhooks, the API) whose runs are picked up again. Their answer is not delivered anywhere. An agent-to-agent run that names the agent which asked is always picked up: its answer goes to that agent. |
| `resume.crashLoop` | object | `{}` | Stops picking up work when the daemon keeps restarting. |
| `resume.crashLoop.restarts` | number (1 or more) | `3` | This many restarts… |
| `resume.crashLoop.windowMinutes` | number | `10` | …within this many minutes pauses picking up work. |

## `reminders`

Hands due Apple Reminders back to the agent that created them. macOS only, off by default. See [Hand due reminders back to agents](/automations/reminders).

| Key | Type | Default | What it does |
|---|---|---|---|
| `reminders.enabled` | boolean | `false` | Turns the hand-back on. Ignored, with a log line, on machines other than a Mac. |
| `reminders.lists` | list of strings | `["AgentX"]` | Reminders lists to watch. |
| `reminders.pollSeconds` | number (15 or more) | `60` | How often the lists are read. |
| `reminders.lookbackHours` | number | `24` | A reminder overdue by more than this (the daemon was off) is reported to its agent, not run. |
| `reminders.command` | string | `"remindctl"` | The `remindctl` program, or its full path when the daemon can't find it. |

## Check it worked

1. **Terminal:** in the folder with `agentx.json`, run `agentx config check`. It prints `✓ Config valid`.
2. **Terminal:** run `agentx config get <path>` for the key you changed, for example `agentx config get workflows.matching.mode`. It prints the new value.
3. **Terminal:** for a job, run `agentx schedule list`. The job appears with its schedule.

## If something is wrong

- **`config check` says a cron needs a prompt or a command:** add one of them to that job.
- **`config check` rejects `autonomy` on a job:** the job has a `command`. Remove `autonomy` or the command.
- **A webhook is refused with 401:** the entry has `secretEnv`, but that variable is missing from `.env` or holds a different secret. Fix it and restart the daemon.
- **A job stopped running:** it may have been turned off after 3 failures (`onError` includes `disable`). Fix the cause, then set `enabled` back to `true`.
