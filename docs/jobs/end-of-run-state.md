# Say where the work stands when a run ends

An agent's run can end before its work does. It may be waiting for a review, have work left for later, or be stuck. Before, a run that ended without an error counted as finished, so work like this went quiet.

Now a run of agent work ends by stating its **job's state**:

| State | What the run gives |
|---|---|
| `done` | The proof: a link, an id, or what it checked. |
| `continue` | What is left, and when it carries on. |
| `waiting` | On whom or what, and until when. |
| `blocked` | Why. |

This applies to work one agent gives another (`a2a`), scheduled jobs (`cron`), reminders and events. Chat answers to a person are not checked.

## How an agent states it

There are two ways. The agent can call the `agentx_job_state` tool before it ends the run:

```json
{ "state": "waiting", "on": "devops review", "until": "2026-11-14T21:00:00Z" }
```

Or it can end its reply with one line:

```
State: done — https://github.com/acme/app/pull/9
```

`agentx_waiting` also counts: a run that called it ends `waiting`.

Every run on these channels starts with one line that reminds the agent of the rule.

## When a run states nothing

1. AgentX asks the agent once, in the same conversation, for one line with the state. The asking agent still gets the run's own answer, not the reply to this question.
2. If the agent still gives no state, or the question fails, the job is **stalled**. A line is added to the answer: `[Job stalled] <agent> ended its run without saying whether the work is done, continuing, waiting or blocked…`. The agent that asked reads it with the answer. One `job_stalled` [failure signal](./failure-signals.md) is recorded.

A state given with the tool, or when asked, is added to the end of the answer as `[Job state] …`, so the agent that asked sees it too. A state already on the answer's last line is not repeated.

## On the job

When the run belongs to a job in the jobs ledger, the state is written on that job:

- `done` closes the job with its proof.
- `continue` stores what is left and when to wake it. A time that is not an ISO date (such as "tonight") is kept in the note, and the job is looked at again after one hour.
- `waiting` stores who it waits on and until when. With no readable time, it is due after one hour.
- `blocked` stores why.
- A stalled job is marked `stalled`, and its requester counts as told: the answer they received says so.

The time the run was asked for a state is also stored on the job.

## Settings

| Key | Default | What it does |
|---|---|---|
| `jobState.enabled` | `true` | Turns the check on or off. |
| `jobState.channels` | `["a2a", "cron", "reminder", "events"]` | Channels whose runs must state a job's state. Workflow steps are not on the list: the workflow engine already asks each step for done or failed. |

## Check it

1. **Terminal:** send an agent a task from another agent, with `agentx daemon send` or `agentx_send_agent`. Ask it to end with `State: done — <a link>`. The answer that comes back ends with that line, and the daemon log shows `[job-state] <agent> a2a …: done — <the link>`.
2. **Terminal:** send a task and ask the agent not to state anything, twice. The log shows `ended with no state; asking once`, then `stalled`. The answer ends with `[Job stalled]`, and `agentx improve signals --kind job_stalled` lists one row.
3. **Terminal:** send a person's chat message on Telegram. Its run gets no reminder line and no question.
