# When an agent asks another agent for you

Sometimes the agent you are talking to needs help from another agent. The other agent may be on the same machine or on another machine in your mesh (the group of AgentX machines that work together, see [Add a second machine](./second-machine.md)). Handing work to another agent is called **delegating**.

When **you** started the conversation, your agent does not keep you waiting while the other agent works:

1. You ask your agent something, for example on Telegram or in the phone app.
2. Your agent asks the helper agent and gets a short receipt with a task id straight away.
3. Your agent tells you who it asked and why, and its turn ends. You can keep chatting.
4. When the helper finishes, its answer comes back to your agent as a new message in the same conversation.
5. Your agent reads the answer and sends you an update in the same chat.

If the helper fails, takes too long, or the machine restarts while it works, your agent still gets a message saying so, and tells you. You never have to ask "is it done yet?".

When your agent asked several helpers at once, their answers come back together as one message. Your agent then sends you one update instead of one per helper. An answer waits up to two minutes for the other helpers still working; after that it comes back without them, and theirs follow later.

Work that an agent started on its own, such as a schedule or a workflow, does not change: the agent waits for the helper's answer, as before.

## When AgentX restarts

AgentX writes down every piece of work it hands out, in its database on the machine of the agent that asked. After a restart it reads that back:

- **The helper was still working, or was about to start:** if the helper is on this machine, AgentX sends it the same message once more after the restart, with a first line saying an earlier run was stopped. Its answer then comes back as usual. If that second run is stopped by a restart too, or the helper is on another machine, your agent is told the work "was lost", or that it failed, and tells you. Turn this off with `resendAfterRestart` below.
- **The answer was back, but your agent had not started passing it on** (for example, it was busy with another message in the same chat): your agent passes it on once, right after the restart (unless `requeueRelayOnRestart` is off).
- **Your agent was passing it on when AgentX stopped:** it tries once more after the restart (see `requeueRelayOnRestart` below). If that try is stopped or fails too, you get a short message saying the answer could not be passed on.

Each answer is passed on at most once more, never in a loop.

Older versions of AgentX kept this list in a file, `.agentx/a2a/delegations.jsonl`. AgentX no longer writes that file. If a machine still has one, AgentX copies it into the database once at start, then renames it to `delegations.jsonl.imported`. The renamed file is never read again. Keep it: it is what you need to roll back to an older AgentX (see **If something is wrong**). If the file cannot be renamed, AgentX removes it instead.

## Which chats this applies to

It applies when a person started the conversation on one of these: Telegram, WhatsApp, a GitLab or GitHub comment, the phone app, voice, or the dashboard chat.

A GitLab or GitHub comment written by an agent does not count as a person's, even when it was posted with a person's account. AgentX recognises these comments by the hidden AgentX signature at the end. Every comment AgentX posts carries it. The signature counts only when:

- the comment was posted by an account AgentX itself posts with: the owner of one of its tokens, its GitHub App, or a name listed in `githubUsernames` or `gitlabUsernames` under `agentMappings`;
- it is outside quoted lines and code blocks.

Anyone else who types the signature, or quotes an agent's comment in a reply, is still treated as a person. The visible "🤖 **agent-name** (via AgentX)" line on its own is not enough.

The update needs a way back to you:

- Chat apps, GitLab and GitHub: the update is posted in the same chat or thread.
- Phone app, typed or spoken: the update is added to the same conversation in the app's **Chat** tab. It is marked **New**, so it shows in the conversation strip, as a banner and in the spoken answers, like any answer that finishes while you look elsewhere. With the app closed, you get the usual [notification when a chat answer finishes](../dashboard/mobile-alerts.md#notifications-when-a-chat-answer-finishes), if that switch is on for your phone. This works for agents on other machines too.
- Voice on the computer and the dashboard's **Ask an agent** panel: these have no conversation the update can be added to, so it arrives as a phone notification. This needs [phone notifications](../dashboard/mobile-alerts.md) set up. Without them, your agent waits for the helper's answer as before. Your agent still has the update when you next ask it.

## Settings

These settings live under `mesh.delegation` in `agentx.json`. They apply to helpers on the same machine too, even with the mesh turned off.

| Setting | Default | What it does |
|---|---|---|
| `mesh.delegation.asyncWhenHuman` | `true` | Turn it off (`false`) to make every agent wait for its helper, as in older versions. |
| `mesh.delegation.timeoutMinutes` | `30` | How long a helper has to answer. After this, your agent is told it timed out, and a helper on this machine is stopped. |
| `mesh.delegation.requeueRelayOnRestart` | `true` | If AgentX restarts while your agent is passing a helper's answer on to you, your agent tries once more after the restart. Turn it off (`false`) to skip that second try. With it off, an answer your agent had not started passing on is not passed on after a restart either. |
| `mesh.delegation.resendAfterRestart` | `true` | If AgentX restarts while a helper on this machine is working on, or waiting to start, a message from your agent, the helper gets the message once more after the restart. Turn it off (`false`) to have such work reported as lost or failed, as in older versions. |
| `mesh.delegation.callbackSends` | `true` | When one agent sends another a message and no person is waiting, the answer, a failure or a timeout still comes back to the sending agent, in the chat it sent from. Turn it off (`false`) to only queue such messages, as in older versions. |
| `mesh.delegation.coalesceSeconds` | `120` | How long a helper's answer waits for the other helpers your agent asked from the same chat, so they all come back as one message. From 0 to 900. With `0`, only answers that are already in are joined. |
| `mesh.delegation.topicSessions` | `false` | Turn it on (`true`) so a message that names one issue or merge request, but no `home`, continues the helper's last run on that issue while it is still fresh (see **One issue named in the message** below). Read at start: restart AgentX after changing it. |
| `mesh.delegation.agentChains.perAgentHour` | `15` | For work no person asked for (a schedule, or agents asking each other), how many times one agent may hand work to another agent in any one hour. Past it, the agent is told to finish the work itself or write to you once. Work you asked for is never counted. `0` turns this off. |
| `mesh.delegation.agentChains.perChainDay` | `40` | The same, for one chain of work: everything that grew from the same first message, whichever agents handle it, in any 24 hours. `0` turns this off. |

To change one:

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx config set mesh.delegation.timeoutMinutes 45`.
3. **Terminal:** run `agentx daemon restart --when-idle` so the daemon reads the new value.

## For agent builders

Agents delegate with the `agentx_task` or `agentx_send_agent` tools, or with a `POST /task`, `/send/agent` or `/mesh/task` request to the daemon on their own machine. **An agent never waits for another agent.** When the request comes from an agent, these always return at once with status `202` and a *receipt*: a body with a `taskId` that starts with `dlg-`. When a person started the conversation, it looks like this:

```json
{ "accepted": true, "mode": "callback", "taskId": "dlg-…", "agent": "helper", "note": "Delegated to helper (task dlg-…). …" }
```

The answer arrives later as a message that starts with `[agentx:delegation-result task=… from=… status=…]`. The status is `done`, `error`, `timeout` or `lost`. Each task id is delivered once; late or repeated answers are dropped.

Which agent is asking decides this, not the request's options:

- **An agent asks** (the request names its running turn, or comes from this machine and names one of this machine's agents in `senderAgentId`): a receipt, always. `"stream": true`, an `Accept: text/event-stream` header and `"async": false` are ignored, and the receipt says so with `"streamIgnored": true` or `"asyncIgnored": true`.
- **Nobody names an agent** (the `agentx` command line, workflow steps, another machine of the mesh, the phone app, `agentx mesh ask`, a stream proxy): `/task` and `/mesh/task` wait for the answer, as before. `/send/agent` answers `202` for them too.
- **A guest host** (a machine this one joined as a guest) is the one exception: a `/mesh/task` to it is one request that waits for the answer, for an agent too.

So that the answer can come back as a new message, the daemon must also be able to tell which *turn* is asking. The tools do this for you. A request made from a shell names its turn with the header `X-AgentX-Task: $AGENTX_TASK_ID`, or with `callerChannel` and `callerChatId` in the body. When only the agent is named (`senderAgentId`), the request still gets a receipt, but its answer is read by its id (see [Sending with `agentx_send_agent`](#sending-with-agentx-send-agent)).

Channel and chat are accepted on purpose: an agent kept warm between turns has no per-turn id to show. The daemon still requires exactly one running turn of that agent on that chat, so what a program on this computer could do with the pair is limited to that turn's own statements about its own request. A per-process secret would close this; it is noted, not built.

A turn no person started (another agent, a schedule, a workflow) gets the answer back as a new message in its own chat too, as described for sends below.

### Look it up instead of asking

In an office, you check the board before you interrupt a colleague. Agents can do the same with the `agentx_lookup` tool. It answers from what AgentX already keeps, starts no run on the other agent's side, and uses no AI model.

- **`agent`:** what that agent is working on now, its open requests from you, its hand-offs still running, and what it finished in the last 48 hours, with the start of each answer. An agent on another machine of the mesh is looked up on that machine.
- **`work`:** everything about one piece of work: an issue or merge request link, a `group/project#12` or `group/project!12` ref, or a request id (`req-…`). It lists your requests about it (open, or closed in the last 7 days) and every run about it in the last 7 days, newest first. On a large history the search stops after 5 seconds and says that older runs were not read. A short `!12` counts when the same message names the project. A bare `#12` never does.
- **`handoff`:** one hand-off by its `dlg-` id, from a receipt or a notice: who asked whom, how it ended and the answer. The tool reads it as the agent it runs for, so it shows only hand-offs that agent asked for or worked on. The same answer is at `GET /lookup?handoff=<id>&as=<agent>`.

What it never shows:

- The words of a run that came from a person's own chat (the phone app, chat apps, voice, email, the dashboard), or from your answer on a decision card, with its note. Such a run shows only that it happened and what work it was about.
- The words of an `api` run you sent (sender `operator` or `owner`), or of an older `api` run whose sender was not recorded. A script's `api` runs show.
- Anything older than those windows, or the full text of an answer (except for one `handoff`, up to 12,000 characters). For the full text, read the chat with `agentx_recent`.

The same answers are at `GET /lookup?agent=<id>` and `GET /lookup?work=<ref>` on the daemon. Another machine of the mesh needs the mesh token to read them.

Agents are told to look things up first. They message a colleague only for work or a decision, and send information that needs no answer as a [notice](#a-notice-instead-of-a-run) (`notice: true` on `agentx_send_agent`).

### Sending with `agentx_send_agent`

`agentx_send_agent` and `POST /send/agent` never wait for the other agent to finish. The daemon answers with status `202` at once.

When no person started the conversation (another agent, a schedule, a workflow) and the daemon can tell which turn is sending, the answer still comes back to the sender. It arrives as a new message in the same chat the sender asked from, where its work lives. A failure or a timeout comes back the same way. The message then asks the sender to choose: resume the work, split it into smaller asks, or drop it and tell whoever waits on it. The body looks like this:

```json
{ "accepted": true, "mode": "callback", "taskId": "dlg-…", "agent": "helper", "note": "Sent to helper (task dlg-…). …" }
```

A send to an agent on this machine may run as long as that agent's own `maxExecutionMinutes`, plus up to 25 minutes waiting for a free slot. A run that passes its time limit answers with the time-limit error, and its job carries the work on (see [work that runs past its time limit](/jobs/restart-safely#work-that-runs-past-its-time-limit)). The 30-minute `mesh.delegation.timeoutMinutes` does not cut it off. A send to an agent on another machine still uses `mesh.delegation.timeoutMinutes`.

If the other agent writes back to the sender with `agentx_send_agent` while it works, that message goes into the sender's chat for that work too. It does not open a new chat. When the other agent's run ends, the sender is still told how it ended, because what it wrote may only have been a progress note. There is one exception: if the run finished well and its final answer mostly repeats what the other agent already wrote (half or more of its words), the sender is not woken again. The daemon log shows `end repeats what it already wrote … no callback turn`. A run that fails, times out or ends to wait is always reported.

The callback turn is the sending agent's own work. Nothing from it is sent to a person. A send made from a person's chat (for example, while passing a helper's answer on to them) is not called back this way; its answer is read by its id, as below.

A callback can lead to a new send, which calls back in turn. The count of such hops travels with the work in both directions, to agents on other machines too. After four, sends go out without a callback, so two agents cannot keep calling each other back.

Otherwise (the daemon cannot tell which turn is sending, the send comes from a person's chat or is past four hops, or `mesh.delegation.callbackSends` is `false`), the send is still a hand-off with a `dlg-` id, but no turn is called back. The receipt says `"mode": "none"`:

```json
{ "accepted": true, "mode": "none", "taskId": "dlg-…", "agent": "helper", "note": "Sent to helper (task dlg-…). … read the answer with agentx_lookup (handoff: \"dlg-…\") or GET /a2a/delegations/dlg-…?as=<you>. …" }
```

- When the sender is one of this machine's agents, it gets a short **notice** when the hand-off ends, at the start of its next run (or as a run of its own after an hour; see [A notice instead of a run](#a-notice-instead-of-a-run)). The notice gives the id and how it ended. The sender then reads the answer by its id: with the `agentx_lookup` tool (`handoff: "dlg-…"`), or `GET /lookup?handoff=<id>&as=<sender>`, or `GET /a2a/delegations/<id>?as=<sender>`. All three use the same rules: an agent reads only hand-offs it asked for or worked on.
- A sender that names no agent of this machine is recorded as `?`. Nobody is told; the answer is read by its id with the operator key. If it gave a name in `senderAgentId` (a script, say), that name keeps a session of its own with the other agent and shows as the message's sender, marked "(not an agent of this machine; its name is not checked)" so the other agent does not take it for one of its own; a sender with no name at all shares one session.
- If the agent on this machine is busy with other work, the message waits in line for it to be free, for up to 6 hours, and then runs. The daemon log shows `busy, waiting for a slot (up to 360m)` when it starts waiting. Unlike before, the hand-off survives a restart: it then ends `lost`, and the sender is told.

`"async": false` no longer makes a send wait. It is ignored, and the receipt carries `"asyncIgnored": true`.

**Before this version** a message sent this way got a `snd-…` id and ran on one chat per sender. Its answer could not be read later. One session per sender is kept: see [One session per piece of work](#one-session-per-piece-of-work).

Sending the same message from the same agent to the same agent again within 10 minutes is treated as a retry. The daemon does not deliver it twice; it answers with the first task id and `"duplicate": true`. A hand-off with a `dlg-` id uses a finer check instead: the same message from the same conversation, on the same home, joins the first one while it is still running, and a new run starts once it has ended. See [What happens when the same message is sent twice](../reference/a2a.md#what-happens-when-the-same-message-is-sent-twice).

An agent working for another agent sees a chat ID such as `a2a:helper-a:helper-b:dlg-…`: the agent that asked comes first, then the one asked. A message posted to `POST /send` with `"channel": "a2a"` and that chat ID goes to the other agent in it, exactly as a `/send/agent` would. Put the sending agent in `"agentId"`; without it, the message goes to the agent that asked. For example, from a script run by `helper-b` (terminal):

```sh
curl -s -X POST http://127.0.0.1:18800/send -H 'Content-Type: application/json' \
  -d '{"channel":"a2a","chatId":"a2a:helper-a:helper-b:dlg-1","agentId":"helper-b","text":"Tests are green"}'
```

The answer is the same `202` body as `/send/agent`. The `/send/agent` options `home`, `context` and `taskType` work here too; `"async": false` is ignored, as on `/send/agent`. A chat ID that does not name two agents, or an `agentId` that is neither agent in the chat, is refused with `400` and a hint to use `/send/agent`.

If the tool gets no answer from the daemon in time, it says the message was **probably delivered**, not that it failed. Sending it again is safe, for the reason above. The daemon log has a `[delegation dlg-…] … started` line for each hand-off, and `GET /a2a/delegations` lists it.

### One session per piece of work

When a follow-up about the same work goes to an agent as a new message, the agent should not start a second session beside the one already working on it. Name the work with `home`, the link of the issue or merge request, or a reference such as `group/project#12`, on `agentx_task` or `agentx_send_agent` (`"home"` in the body of `/task` and `/send/agent`):

- A new message on the same `home` to the same agent on this machine waits until the run already on it ends. It then continues that run's session, so the agent keeps what it knew. This applies when the earlier run is still going or ended in the last 12 hours, and to messages whose answer comes back as a new message (see above). A continued session is still renewed by AgentX when it grows too long or goes quiet, as any chat's is.
- If the earlier run failed before it saved a session, the new message continues the run before that one (AgentX remembers the last three).
- For a home that names its project (`group/project#12` or a link), the wait is part of the **home lease** described below: one run at a time per agent and issue, whatever started it. For any other home (a request ID such as `req-01ABC…`, a link that is not an issue or merge request), or with the lease turned off, the new message waits here for the hand-off ahead of it, within its own time limit.
- A link and a reference to the same issue count as the same home: `https://git.example.com/team/app/-/issues/12` and `team/app#12` match. A merge request (`team/app!12`) is a different home from the issue with the same number.
- When a run of an agent starts while another run of the same agent, in another chat, works on the same issue, the new run is told so in a first line that starts with `[agentx:same-home]`. It names the other run's chat and start time, and asks the agent to coordinate rather than redo or overwrite that work. The issue is taken from `home`, or from issue and merge request links and `group/project#12` references in the message. A bare `#12` is not used, because it names different work in every project.

### One run per agent and issue (home lease)

While a run of an agent works on an issue, pull request or merge request (its **home**), another run of the same agent on that home waits for it to end, then runs as its own turn with a first line that starts with `[agentx:same-work` and gives what the earlier run answered. Different agents may still work on the same home at the same time. Rules:

- **Which runs take the lease:** a run whose home is named (`home` on a hand-off, a `/task` body, a job, or a workflow `agent` step's `home`), and a run on a GitLab or GitHub issue or merge request thread. The home must name its project (`group/project#12`, `group/project!12`, or a link). Nothing is read from the message text, and a bare `#12` takes no lease.
- **Never held:** a person's own chat (the phone app, chat apps, voice, the dashboard and terminal chats, guests), the question a run is asked about its job state after it ends, an agent that runs on another machine, and a workflow's follow-up reminder (it names no home).
- **A caller that waits for the answer** (a hand-off, `/task`, a workflow step, an event wake, a schedule) waits within its slot-wait budget, 25 minutes by default. The wait for the home and the wait for a free slot after it share that one budget. A task from another machine gets 20 minutes, so its answer reaches that machine before its own 30 minute limit. Past the budget the run is refused with an error that starts with `home_busy` and never runs, so a retry is never a second run of the same work. The caller (the asking agent, for a hand-off) decides whether to send it again. A caller that gives up while waiting, or a hand-off that reaches its time limit, leaves the line the same way.
- **A hand-back waits too:** when agent A, working on an issue, asks B and waits for the answer, and B in turn asks A about the same issue, B's message to A waits for A's lease, which A holds while it waits for B. It waits until its budget runs out and is then refused with `home_busy`. Have B answer A instead of asking A on the same issue, or send it without a `home`.
- **A comment on the issue or merge request thread**, and a job's wake, have no caller waiting: they wait their turn and are never refused. Waiters are served first in, first out.
- **A stuck run:** a run still going 5 minutes past its agent's time limit (`maxExecutionMinutes`, or the task's own limit) is stopped, and the lease goes to the next waiter 30 seconds later. This is recorded as a `duplicate_session` signal.
- A message that is refused, put on hold, or held by the monthly budget is answered before it waits, so it never takes a place in the line.
- **What you see:** the daemon log shows `joined <run> on <home> from <channel>:<chat>` when a run starts waiting and `refused (home_busy), not run` for a refusal. A `task:joined` event names the run waited for, and the signals `same_work_joined` and `home_busy` count both. Each run's trace keeps the home it held (`home`), so runs started on a home beside another run of the same agent can be counted per week.
- `agentx exec` builds its own registry and sees none of the daemon's leases.
- Turn it off with `homeLease.enabled: false` (see [configuration](/reference/config-automation#homelease)).

**Owner's requests.** A message to an agent that names one of the owner's [requests](/jobs/open-requests) (an ID such as `req-01ABC…`) waits while another run of the same agent works on that request, from any chat. This covers a plan step and another agent's message about the same request arriving seconds apart. When it starts, its first line begins with `[agentx:same-work`. That line gives the other run's answer and asks the agent not to redo that work. Rules:

- A person's own chat never waits: the phone app, chat apps, voice, the dashboard and terminal chats, and chats with guests or the public API.
- A run that belongs to the same chain of work as the one it would wait for goes ahead at once, so an agent's own hand-off coming back cannot get stuck.
- The wait lasts at most 15 minutes. After that the run goes ahead beside the other one. The daemon log shows `going ahead beside a run still on it`.
- The other run's answer is passed on if it ended in the last 45 minutes.

Without `home`, the chat the message is sent from counts as its home, with a shorter window. When the same agent asks the same helper on this machine again from the same chat, and the helper's last run from that chat ended in the last 2 hours, the helper continues that run's session instead of starting a new one. The daemon log shows `continues its session from <channel>:<chat>`. Such a message never waits: if the helper's last run from that chat is still going, the new one starts a fresh session beside it.

A send whose answer is read by its id (`"mode": "none"`) keeps **one session per sender**: the helper continues the session of its last run for the same sending agent (or for all senders that name no agent, together), if that run ended in the last 12 hours. The daemon log shows `continues its session from <sender>'s last send`. This survives a restart: AgentX finds the last such run in its database. The first send after upgrading continues the session the sender used before the upgrade. Things to know:

- A second send from the same sender while the helper's last run for it is still going starts a fresh session beside it. Before, it could be read by the running turn. The daemon log shows `follow-up from <sender> to <helper> while its last run is going; starts fresh beside it (N since start)`.
- Each send runs in its own chat, `a2a:<sender>:<helper>:dlg-…`. The session continues, but `agentx_recent` on that chat shows only that send's messages.

**One issue named in the message.** With `mesh.delegation.topicSessions` on, a message with no `home` whose text names exactly one issue or merge request (a link, or a reference such as `group/project!12`) continues the helper's last run on that issue on this machine, from any chat or sender. Rules:

- Only while that run's saved context is still cheap to reuse: it ended less than `session.resumeGate.cacheTtlMinutes` ago (an hour by default). After that, the message starts a fresh session.
- It never waits. If the helper's last run on that issue is still going, the new message starts a fresh session beside it. While a run continues a session, no other message continues that same session, whichever rule it follows.
- It is not a `home`. The issue is not written on the hand-off, the helper's run is not told it as its home, and nothing waits for it. Only a named `home` waits its turn.
- A message that names two or more issues, or only a bare `#12`, gets no topic and follows the rules above.
- It survives a restart: AgentX reads the issue again from the stored message (its first 500 characters). A message longer than that gets no topic after a restart, since the cut part may name another issue; the next message on that issue starts fresh.
- The first message on an issue still follows the rules above (the same chat, or the same sender).
- The daemon log shows `continues its session from its last run on <issue>`. With the setting off, it shows `would continue <chat> on <issue> (topicSessions is off)` where a message would have continued, so you can count them before turning it on.
- AgentX does not copy any message into the new chat. To check that the new message really belongs to the same work, AgentX compares it with the last message of the chat it continued from. It does this only for a message continued this way; with the setting off, nothing changes.

### A notice instead of a run

Some messages are only for information: a watch script saying the machine has been on battery for 30 minutes, for example. Add `"notice": true` to the `/send/agent` body, and the message does not start a run. It is put at the head of the agent's next run of agent work: a message from another agent, a schedule, a workflow, a reminder, an event or the business day cycle. It never goes into a person's or a guest's chat. It appears under a line starting `[agentx:notices`. If no such run starts within an hour, the waiting notices go to the agent together, as one run. For example (terminal):

```sh
curl -s -X POST http://127.0.0.1:18800/send/agent -H 'Content-Type: application/json' \
  -d '{"agentId":"helper","senderAgentId":"watcher","notice":true,"text":"On battery for 30 min, now 63%."}'
```

The answer is `202` with `"status": "notice"` and how many notices wait for that agent. Things to know:

- Up to 20 notices wait per agent. When there are more, the oldest are dropped.
- Notices are kept in `.agentx/notices.json` in the daemon's folder, written each time one is added or passed on. A daemon restart keeps the ones not yet passed on, and the log says `[notices] N notice(s) kept from before the restart`. The hour still counts from when each was sent.
- A notice older than 24 hours when the daemon starts is dropped: it is for information, and stale after a long outage. Notices for an agent no longer in the config are dropped at the hourly check.
- A notice is passed on once at most. It is taken when the run really starts, after any wait for a free place, and is gone from the file before the run's model sees it. If that run fails, or the daemon stops during it, the notice is not sent again. The hourly run takes its notices before it waits, so a restart during that wait loses them.
- Notices work for agents on this machine only. For an agent on another machine, the message is sent as usual.
- Send anything urgent as a plain message, without `notice`. For an alert, add `"priority": "critical"`: see below.

### An alert that must not wait

A message that must start soon, such as a battery or disk alert, can be sent with `"priority": "critical"` on `/send/agent` (or `priority: "critical"` on `agentx_send_agent`). The machine running the other agent then starts it even while its swap or load is high. Low memory, low disk and the session limit still hold it. Details: [Alerts that must not wait](/jobs/session-queue#alerts-that-must-not-wait).

### When the helper's run ends before the work does

Sometimes a helper ends its run to wait: for a build, a deploy, a monitor, or another agent. Its reply then is not the end of the work. The helper says so with the `agentx_waiting` tool before it ends the run, giving what it waits for (`on`) and, if it knows, when the wait should be over (`due`, an ISO time). The answer that comes back to the asking agent then says the work is **not finished** and what it waits for, with status `waiting`, instead of "finished". An open request stays "waiting on another agent",, due at that time.

The tool works only from inside the helper's own run (`POST /runs/waiting` on its own machine).

Every helper run now ends by stating its job's state: done, continue, waiting or blocked. A helper that states nothing is asked once; still nothing, the answer says the job is stalled. Only a helper that states `done` is reported as finished: `continue` and `waiting` come back with status `waiting`, and `blocked` or stalled come back with status `error`, each saying the work is not finished. See [Say where the work stands when a run ends](./end-of-run-state.md).

A helper run that ends with no answer at all comes back with status `error` and the text `empty answer from <helper>`. That happens only when the helper also stated no job state, did not use `agentx_waiting`, and wrote nothing back to the asking agent during the work. If it did any of those, its empty end is not an error.

A `/mesh/task` request whose own `context` names a chat (`channel` and `chatId`) keeps its older behaviour. With `"async": true`, the helper's plain answer is posted to that chat, and no callback turn runs. Such a request is still a hand-off with a `dlg-` id that you can read later, and a repeat while it runs starts nothing: see [Get the answer later, in a chat](../reference/a2a.md#get-the-answer-later-in-a-chat).

Some requests are refused straight away with status `409`:

- An agent asking itself.
- A request that could never start, because every slot of the target agent is held by a turn that is waiting on the asking agent. For example, A asks B, B asks A, and A can only run one task at a time. This is checked on one machine only.

## Check it worked

1. **Chat app:** ask your agent to get something from another agent, for example "ask the helper agent for today's build status".
2. Your agent replies straight away, saying who it asked.
3. A little later, your agent sends a second message with the helper's answer.
4. **Terminal:** have an agent ask another one from a script, naming itself, and check it gets a receipt at once:
   ```sh
   curl -s -m 10 -X POST http://127.0.0.1:18800/send/agent -H 'Content-Type: application/json' \
     -d '{"agentId":"helper","senderAgentId":"asker","text":"What is the build status?"}'
   ```
   The answer comes within a second, with `"accepted": true` and a `dlg-` `taskId`. Read the answer later with `curl -s "http://127.0.0.1:18800/a2a/delegations/<taskId>?as=asker"`.
5. **Terminal:** on the machine that runs your agent, run:
   ```sh
   curl -s http://127.0.0.1:18800/a2a/delegations
   ```
   The newest entry names both agents and shows `"status":"done"`.
6. **Terminal:** run `curl -s "http://127.0.0.1:18800/lookup?agent=<agent-id>" | jq -r .text`. It prints what that agent is on now and what it finished in the last 48 hours.
7. **Terminal:** run `curl -s "http://127.0.0.1:18800/lookup?work=group/project!12" | jq -r .text` with a merge request your agents worked on. It lists the runs about it, newest first.
8. **Topic sessions:** with `mesh.delegation.topicSessions` on, send a helper two messages that name the same `group/project!12`, from two different chats, the second after the first ended. Search the daemon log for `continues its session from its last run on group/project!12`. With the setting off, the log shows `would continue … on group/project!12` instead.

## If something is wrong

- **Your agent still waits for the helper:** an agent never waits since this version, so the request did not name an agent. Check that it sends `senderAgentId` (and, from a script, the `X-AgentX-Task: $AGENTX_TASK_ID` header). A request that names no agent, such as a plain `curl` to `/task`, still waits on purpose. A `/mesh/task` to a guest host always waits.
- **The answer never comes back as a message, only a notice:** the receipt said `"mode": "none"`: the daemon could not name the asking turn, or the send came from a person's chat. Read the answer by its id. To get it as a message, send the `X-AgentX-Task` header from inside the run.
- **The receipt says `"streamIgnored": true` or `"asyncIgnored": true`:** an agent asked to wait or to stream. That is not possible any more; read the answer by its id or wait for the callback.
- **The update never arrives:** open the daemon log and search for `[delegation`. A line ending in `no route to …` means the machine running your agent has no connection to that chat app; set the chat app up on that machine.
- **You get "did not answer in time":** the helper took longer than `mesh.delegation.timeoutMinutes`. Raise it, or ask for a smaller piece of work.
- **You get "empty answer from …":** the helper ended its run with nothing: no answer, no job state, no waiting note and no message back. Open its run on the Hub's **Activity** page to see why, then ask again.
- **You get "was lost":** the machine restarted while the helper worked. Ask your agent to try again.
- **You need to go back to an older AgentX:** Roll back only to 0.235.0 or later. Rolling back further, the older daemon does not report hand-offs still out as lost, does not re-run answers on their way back, and drops a peer's late answer; those hand-offs are reported lost late after coming forward again. If you must go further back, first rename `.agentx/a2a/delegations.jsonl.imported` back to `delegations.jsonl` (restores what the older daemon can read, as of the import).
- **The daemon log says `[delegation] WARNING: … imported but could not be renamed or removed`:** AgentX cannot change files in `.agentx/a2a/`. Fix that folder's permissions so the user that runs AgentX can write to it, then restart AgentX. Until then the old file is read again at every start.
- **After a restart, nobody is told about work that was still out, or you got the notice "Hand-offs kept in memory only":** search the daemon log for `[delegation] WARNING: no database`. **Terminal:** `curl -s http://127.0.0.1:18800/health | jq .handoffs` prints `"memory-only"` on such a machine (`"database"` when all is well). The database (`.agentx/db.sqlite`) did not open on that machine, so hand-offs were kept in memory only. The line before it in the log, starting `[storage/sqlite]`, says why; usually the database module must be installed again (`pnpm install`).
- **You get "could not pass on the answer … because of a restart":** AgentX restarted twice while your agent was passing the answer on, or the second try failed. Ask your agent for the answer again. If you track requests, the request shows what the helper said. In the daemon log, the lines starting `[delegation` with the reference from the message say what happened.
- **`409` with "cannot delegate to itself" or "could never answer":** the request would wait forever. Answer from what the agent already has, or raise the target agent's `maxConcurrent`.
- **The phone conversation gets no update:** the dashboard files it within a few seconds of the agent replying. Check that the dashboard is running (`agentx board serve`). For an agent on another machine, that machine must be up, and the dashboard needs a token for it: the shared mesh token (`MESH_TOKEN`), or its entry in `dashboard.daemons`. The update waits for the dashboard for up to a day, and is dropped if AgentX on that machine restarts first. Your agent still has it when you next ask. A dashboard log line starting `[app] warning:` means the dashboard passed over some updates: it was away too long, or too many arrived at once. Ask your agent for the answer again.
- **`agentx_send_agent` says "probably delivered":** the daemon took more than 10 seconds to confirm. Send the same message again; a repeat while the first is running returns the first task id instead of a second task. Search the daemon log for `[delegation dlg-` to see it was handed off.
- **An agent still messages a colleague just to ask for a status:** check that `agentx_lookup` is not left out by the agent's `session.lean.agentxTools` list. A lean session keeps it while `session.lean.contextOnDemand` is on.
- **`agentx_lookup` finds nothing about a piece of work:** the runs must name it as a link, a `group/project!12` ref, or the project name with `!12`. Work from more than 7 days ago is not searched.
- **An alert sent with `"priority": "critical"` still waited:** search the other machine's daemon log for `[admission]`. `started … (critical) past the gate` means it went past a swap or load hold. A wait on `memory:`, `disk:` or `session cap` is on purpose.
- **A notice never reached the agent:** search the daemon log for `[send/agent] notice` (kept) and `[notices]` (sent after an hour, kept or dropped at a restart). `couldn't save notices to <path>` means the file could not be written, so a restart loses what waits; the line gives the error.
- **An agent seems slow to start on an owner's request:** search the daemon log for the request ID. `another run of this agent is on it` means it waits for that run, for up to 15 minutes.
- **`/send` answers `"is not an a2a chat ID"`:** the `chatId` must look like `a2a:<agent>:<agent>`, optionally followed by `:<id>`. Copy it exactly as your agent was given it, or use `POST /send/agent` with `agentId`.
- **`/send` answers `"is not in a2a chat"`:** the `agentId` you sent is not one of the two agents in the `chatId`. Send as the agent the chat belongs to, or use `POST /send/agent`.
- **A hand-off read by its id ended `error` with `slot wait timed out after 360m`:** the other agent was busy for 6 hours straight, so the message was not run. Raise that agent's `maxConcurrent`, or look for a run that is stuck, then send the message again.
- **A helper started cold after the upgrade, without what it knew:** the sender's last run before the upgrade ended more than 12 hours earlier, so its session was renewed anyway. Look for `continues its session from` in the daemon log for the next send.
- **`agentx_send_agent` says "could not be reached":** the daemon on this machine is not running. Start it with `agentx daemon start --detach`, then send again.
- **A helper continued an unrelated session after a message that named one issue:** the message named that issue only as background. Turn `mesh.delegation.topicSessions` off (`false`) and restart AgentX; sessions go back to the rules before it. To start fresh on one message, name two issues, or none, or give it its own `home`.
- **Topic sessions are on but a helper still starts fresh:** search the daemon log for the hand-off id. No `continues its session from its last run on` line means the last run on that issue ended more than `session.resumeGate.cacheTtlMinutes` ago, is still going, or ran on another machine, or the message named more than one issue.
- **Updates from several helpers arrive one by one:** each answer waits only `mesh.delegation.coalesceSeconds` (two minutes by default) for the others. A helper that takes longer sends its answer later, in a second update. Raise the setting if your helpers usually finish further apart.
- **`409` with "Hand-off budget used":** agents handed each other more work than `mesh.delegation.agentChains` allows, with no person behind it. This is the brake doing its job: the agent finishes the work itself or writes to you. If real work stops because of it, raise `perAgentHour` or `perChainDay`. The daemon log line `[delegation] … refused: Hand-off budget used` names the agent. The counts start over when AgentX restarts.
- **The status list is empty:** hand-offs are listed only on the machine that runs the asking agent, and only those kept in its database (see the `memory-only` entry above).
- **A follow-up started a new session anyway:** check that both messages named the same `home`, and went to an agent on the same machine. After a restart, or 12 hours after the last run ended, a new session starts. The daemon log line `is on … continues its session` shows when a session was continued. The line `a run on … is still going; starting a fresh session instead` means another run still used that session when this one started.
- **Two runs still worked on the same issue:** the second one was told (its first line starts with `[agentx:same-home]`). If it went on anyway, check that its home was named with its project (`group/project#12`), or that it came from the issue's own thread; a home only in the message text takes no lease. A person's chat never waits; only the first line warns it.
