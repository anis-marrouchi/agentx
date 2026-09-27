# Configuration: automation

The settings in `agentx.json` that make agents work on their own: scheduled jobs, services, incoming webhooks, workflows, learned procedures, notifications, approvals, resuming after a restart and due reminders. For the other sections and how to edit the file, see the [Configuration reference](./config.md).

"Default" is the value used when the key is left out. "required" means the entry is rejected without it; "—" means it is unset unless you set it.

## `crons`

Scheduled jobs (also called routines), keyed by job id: `crons.<id>`. Each job either asks an agent to run a prompt or runs a shell command.

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
| `notify` | object | — | Where this job's messages go. |
| `notify.channel` | string | required | Channel for the job's messages, for example `telegram`. |
| `notify.chatId` | string | required | The chat on that channel. |
| `notify.accountId` | string | — | Which account on that channel, when you have more than one. |
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
| `workflows.matching.suggestThreshold` | number (0–1) | `0.65` | How confident a match must be to count at all. |
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
| `notifications.destination.channel` | string | required | Channel, for example `telegram` or `ntfy`. |
| `notifications.destination.chatId` | string | required | The chat on that channel. |
| `notifications.destination.accountId` | string | — | Which account on that channel. |
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

## `approvals`

The Approvals inbox. See [Approvals](/dashboard/approvals#settings).

| Key | Type | Default | What it does |
|---|---|---|---|
| `approvals.defaultExpiryDays` | number (up to 365) | `3` | Days a decision card waits when the agent gave no expiry. |
| `approvals.maxExpiryDays` | number (up to 365) | `30` | The longest any card may wait. |
| `approvals.laterHours` | number (up to 720) | `24` | Hours **Later** hides an item. |
| `approvals.notifyAgent` | boolean | `true` | Tells the agent that raised a card when it is decided or expires. |
| `approvals.digest` | object | `{}` | One reminder a day of what is waiting. |
| `approvals.digest.enabled` | boolean | `true` | Sends the daily reminder. |
| `approvals.digest.time` | string | `"09:00"` | Time of day, 24-hour `HH:MM`. |
| `approvals.digest.timezone` | string | — | Timezone for `time`, for example `Europe/Paris`. Unset: this machine's. |
| `approvals.digest.destination` | object | — | Where the reminder goes. Unset: `notifications.destination`. |
| `approvals.digest.destination.channel` | string | required | Channel for the reminder. |
| `approvals.digest.destination.chatId` | string | required | The chat on that channel. |
| `approvals.digest.destination.accountId` | string | — | Which account on that channel. |

## `resume`

What happens to work a restart cut off. Chat messages are picked up again in their chat; scheduled jobs never are, because their next run covers them. See [restart without losing work](/jobs/restart-safely).

| Key | Type | Default | What it does |
|---|---|---|---|
| `resume.enabled` | boolean | `true` | Picks up cut-off work after a restart. |
| `resume.maxAgeMinutes` | number (1 or more) | `30` | Work older than this is reported, not picked up. |
| `resume.maxAttempts` | number | `1` | How many times a run is picked up again if it keeps getting cut off. |
| `resume.reportOnlyChannels` | list of strings | `[]` | Channels whose runs are only reported, even from a chat. |
| `resume.directChannels` | list of strings | `[]` | Other channels (voice, agent-to-agent, webhooks) whose runs are picked up again. Their answer is not delivered anywhere. |
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
