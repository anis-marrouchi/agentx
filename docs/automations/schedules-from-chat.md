# Ask an agent to schedule something

You can ask an agent, in any chat you already use with it (Telegram, WhatsApp and so on), to do something on a regular basis. For example: "every Monday at 10, check the open invoices and tell me which are late".

The agent turns that into a **schedule**, a job AgentX runs at set times. Nothing it asks for runs until you approve it.

## Before you start

- The agent can use the AgentX tools. Codex and OpenCode agents always can. A Claude Code agent can when its `mcp` settings include the AgentX server (`agentx serve --stdio`).
- Approval requests have somewhere to go: set `notifications.destination` in `agentx.json` (see [Get notified](../jobs/notifications.md)). Without it, requests still wait for you, but nobody tells you about them.

## 1. Ask for it in chat

1. **Chat app:** tell the agent what to do and when, in plain words. For example: "every weekday at 6pm, summarise today's support tickets and send them here".
2. The agent replies that it has asked for the schedule and that it's waiting for your approval.

Timing can be written the way you'd say it: "every morning at 9", "weekdays at 6pm", "every 15 minutes", "1st of every month at noon". To see how AgentX reads a phrase:

```sh
agentx schedule parse "weekdays at 6pm"
```

By default, the job runs as the agent you asked, and after each run its answer is posted back to the chat you asked from. If a run fails, a short failure message goes to the same chat. You can ask for another agent, a time zone, somewhere else to send results, or no chat at all ("don't send me the results"). Without a chat, the results stay in the run history in the dashboard.

If you asked from the AgentX phone app, the answer appears in the same conversation, marked unread. If you asked by voice, it arrives as a push notification on your phone (this needs push notifications set up on this computer).

If you asked from a GitHub or GitLab issue, each answer is posted there as a comment. On a public project anyone can read it. Ask for a private chat instead, or for no chat at all.

If your old schedule prompt already says "send it to my Telegram", remove that line. Otherwise the answer arrives twice: once from the agent, once from the schedule.

In `agentx.json`, this shows up on the job as its `notify` destination. See [Configuration: automation](../reference/config-automation.md#crons).

## 2. Approve or reject it

You get a message with the job's timing, the next time it would run, the agent, where the results go, and what it will do.

1. **Terminal:** on the machine running AgentX, list the schedules. Waiting requests are marked `◐`.
   ```sh
   agentx schedule list
   ```
2. Approve it, using the ID from the list:
   ```sh
   agentx schedule approve <id>
   ```
   Or turn it down:
   ```sh
   agentx schedule reject <id>
   ```

The change takes effect straight away; no restart needed.

You can also answer from the **Approvals** tab in the dashboard, or with `agentx approvals list`, where requests from agents, memory and the wiki wait together. See [Approvals](../dashboard/approvals.md).

A request that isn't approved never runs, even if something else switches it on. Only `approve` releases it.

## What the agent can do

| Ask for | What happens |
|---|---|
| A list | It shows your schedules, whether each is on, who made it, and when it runs next |
| A new schedule | Saved switched off, marked as waiting, and you're told |
| Pause or resume | Takes effect at once, for schedules the agent itself made and you approved |
| Removal | Waits for your approval; the schedule keeps running until then |

An agent can only pause, resume or ask to remove schedules it made. To let an agent manage every schedule, set `"admin": true` on it in `agentx.json`. Even then, only you can approve.

If an agent withdraws its own request before you approve it, the request is simply removed, since it never ran.

<!-- No screenshot: the steps happen in a phone chat app, which the docs demo can't show, and in the terminal. -->

## Check it worked

1. **Terminal:** run `agentx schedule list`. Your new job is listed without the `◐` mark and with a next run time.
2. **Browser:** open the dashboard's **Operations** tab. The job appears under **Routines** as a schedule. See [Routines](../dashboard/operations.md#routines).
3. After its first run, the agent's answer arrives in the chat you asked from.

## If something is wrong

- **The agent says it can't schedule things:** it doesn't have the AgentX tools. Add the AgentX server to its `mcp` settings, then restart the daemon.
- **You never got the approval message:** set `notifications.destination` in `agentx.json`. The request is still waiting in `agentx schedule list`.
- **`approve` says the job isn't waiting:** it was already approved or rejected. Check `agentx schedule list`.
- **The agent can't pause a job:** it didn't make that job. Make the change yourself, or give the agent `"admin": true`.
- **The job ran but no answer arrived in the chat:**
  1. **Terminal:** run `agentx schedule list`. The job's `notify:` line should name the chat and say `(results and failures)`.
  2. If it says `(failures only)`, open `agentx.json` and remove `"deliverResult": false` from the job.
  3. If there is no `notify:` line, the request was made from a place that isn't a chat (for example another schedule). Add a `notify` destination to the job, as in [Send a daily report](../jobs/daily-report.md#deliver-the-report-to-a-chat).
  4. A run that ends with an empty answer sends nothing. Check the run in the dashboard's **Operations** tab.
  5. If the `notify:` line says `voice`, check that push notifications reach your phone. Without them a voice result can't be sent, and the daemon log shows `result delivery failed`.
- **The timing is wrong:** check the phrase with `agentx schedule parse "<phrase>"`, then ask the agent to change it.
