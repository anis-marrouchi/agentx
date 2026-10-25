# When an agent asks another agent for you

Sometimes the agent you are talking to needs help from another agent. The other agent may be on the same machine or on another machine in your mesh (the group of AgentX machines that work together, see [Add a second machine](./second-machine.md)). Handing work to another agent is called **delegating**.

When **you** started the conversation, your agent does not keep you waiting while the other agent works:

1. You ask your agent something, for example on Telegram or in the phone app.
2. Your agent asks the helper agent and gets a short receipt with a task id straight away.
3. Your agent tells you who it asked and why, and its turn ends. You can keep chatting.
4. When the helper finishes, its answer comes back to your agent as a new message in the same conversation.
5. Your agent reads the answer and sends you an update in the same chat.

If the helper fails, takes too long, or the machine restarts while it works, your agent still gets a message saying so, and tells you. You never have to ask "is it done yet?".

Work that an agent started on its own, such as a schedule or a workflow, does not change: the agent waits for the helper's answer, as before.

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

Both settings live under `mesh.delegation` in `agentx.json`. They apply to helpers on the same machine too, even with the mesh turned off.

| Setting | Default | What it does |
|---|---|---|
| `mesh.delegation.asyncWhenHuman` | `true` | Turn it off (`false`) to make every agent wait for its helper, as in older versions. |
| `mesh.delegation.timeoutMinutes` | `30` | How long a helper has to answer. After this, your agent is told it timed out, and a helper on this machine is stopped. |
| `mesh.delegation.requeueRelayOnRestart` | `true` | If AgentX restarts while your agent is passing a helper's answer on to you, your agent tries once more after the restart. Turn it off (`false`) to skip that second try. |
| `mesh.delegation.callbackSends` | `true` | When one agent sends another a message and no person is waiting, the answer, a failure or a timeout still comes back to the sending agent, in the chat it sent from. Turn it off (`false`) to only queue such messages, as in older versions. |

To change one:

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx config set mesh.delegation.timeoutMinutes 45`.
3. **Terminal:** run `agentx daemon restart --when-idle` so the daemon reads the new value.

## For agent builders

Agents delegate with the `agentx_task` or `agentx_send_agent` tools, or with a `POST /task`, `/send/agent` or `/mesh/task` request to the daemon on their own machine. When a person started the conversation, these return at once with status `202` and a body like this:

```json
{ "accepted": true, "mode": "callback", "taskId": "dlg-…", "agent": "helper", "note": "Delegated to helper (task dlg-…). …" }
```

The answer arrives later as a message that starts with `[agentx:delegation-result task=… from=… status=…]`. The status is `done`, `error`, `timeout` or `lost`. Each task id is delivered once; late or repeated answers are dropped.

The daemon must be able to tell which turn is asking. The tools do this for you. A request made from a shell names its turn with the header `X-AgentX-Task: $AGENTX_TASK_ID`, or with `callerChannel` and `callerChatId` in the body. The agent id alone is not enough, and such a request waits for its answer as before.

Channel and chat are accepted on purpose: an agent kept warm between turns has no per-turn id to show. The daemon still requires exactly one running turn of that agent on that chat, so what a program on this computer could do with the pair is limited to that turn's own statements about its own request. A per-process secret would close this; it is noted, not built.

Add `"async": false` to the request body to wait for the answer anyway. Add `"async": true` to get the callback from a turn no person started, such as a schedule. `"async": true` has no effect inside a delegation: a turn that is itself answering another agent, or a turn that carries a delegation result, always waits. This stops one callback from starting another.

### Sending with `agentx_send_agent`

`agentx_send_agent` and `POST /send/agent` never wait for the other agent to finish. The daemon answers with status `202` at once.

When no person started the conversation (another agent, a schedule, a workflow) and the daemon can tell which turn is sending, the answer still comes back to the sender. It arrives as a new message in the same chat the sender asked from, where its work lives. A failure or a timeout comes back the same way. The message then asks the sender to choose: resume the work, split it into smaller asks, or drop it and tell whoever waits on it. The body looks like this:

```json
{ "accepted": true, "mode": "callback", "taskId": "dlg-…", "agent": "helper", "note": "Sent to helper (task dlg-…). …" }
```

A send to an agent on this machine may run as long as that agent's own `maxExecutionMinutes`, once more for each time a run that passes it is picked up again (`resume.timeLimit`, once by default: see [work that runs past its time limit](/jobs/restart-safely#work-that-runs-past-its-time-limit)), plus up to 25 minutes waiting for a free slot. The 30-minute `mesh.delegation.timeoutMinutes` does not cut it off. A send to an agent on another machine still uses `mesh.delegation.timeoutMinutes`.

If the other agent writes back to the sender with `agentx_send_agent` while it works, that message goes into the sender's chat for that work too. It does not open a new chat. When the other agent's run ends, the sender is still told how it ended, because what it wrote may only have been a progress note.

The callback turn is the sending agent's own work. Nothing from it is sent to a person. A send made from a person's chat (for example, while passing a helper's answer on to them) is not called back this way; it is queued as below.

A callback can lead to a new send, which calls back in turn. The count of such hops travels with the work in both directions, to agents on other machines too, and a [watcher](../automations/task-watchers.md) alert about the work counts as one more hop. After four, sends go out without a callback, so two agents cannot keep calling each other back.

Otherwise (the daemon cannot tell which turn is sending, the send comes from a person's chat or is past four hops, or `mesh.delegation.callbackSends` is `false`), the message is queued and its answer is not returned to the sender:

```json
{ "accepted": true, "status": "queued", "taskId": "snd-…", "agent": "helper", "note": "Queued for helper (task snd-…). …" }
```

Add `"async": false` to the request body to wait for the answer, as in older versions.

Sending the same message from the same agent to the same agent again within 10 minutes is treated as a retry. The daemon does not deliver it twice; it answers with the first task id and `"duplicate": true`.

An agent working for another agent sees a chat ID such as `a2a:helper-a:helper-b:dlg-…`: the agent that asked comes first, then the one asked. A message posted to `POST /send` with `"channel": "a2a"` and that chat ID goes to the other agent in it, exactly as a `/send/agent` would. Put the sending agent in `"agentId"`; without it, the message goes to the agent that asked. For example, from a script run by `helper-b` (terminal):

```sh
curl -s -X POST http://127.0.0.1:18800/send -H 'Content-Type: application/json' \
  -d '{"channel":"a2a","chatId":"a2a:helper-a:helper-b:dlg-1","agentId":"helper-b","text":"Tests are green"}'
```

The answer is the same `202` body as `/send/agent`. The `/send/agent` options `async`, `home`, `context` and `taskType` work here too: `"async": false` waits for the answer. A chat ID that does not name two agents, or an `agentId` that is neither agent in the chat, is refused with `400` and a hint to use `/send/agent`.

If the tool gets no answer from the daemon in time, it says the message was **probably delivered**, not that it failed. Sending it again is safe, for the reason above. The daemon log has a `[send/agent] snd-…` line for each queued message, and a `started as run …` line when the other agent picks it up.

### One session per piece of work

When a follow-up about the same work goes to an agent as a new message, the agent should not start a second session beside the one already working on it. Name the work with `home`, the link of the issue or merge request, or a reference such as `group/project#12`, on `agentx_task` or `agentx_send_agent` (`"home"` in the body of `/task` and `/send/agent`):

- A new message on the same `home` to the same agent on this machine waits until the run already on it ends. It then continues that run's session, so the agent keeps what it knew. This applies when the earlier run is still going or ended in the last 12 hours, and to messages whose answer comes back as a new message (see above). It waits at most as long as its own time limit. A continued session is still renewed by AgentX when it grows too long or goes quiet, as any chat's is.
- If the wait runs out while the earlier run is still going, the new message starts a fresh session instead, so two runs never write to one session. Its own time limit starts only then.
- If the earlier run failed before it saved a session, the new message continues the run before that one (AgentX remembers the last three).
- Only messages from one agent to another whose answer comes back as a new message (see above) wait their turn. A queued send, or one with `"async": false`, does not wait. A run on the same issue that starts another way, for example from a person's own chat or a schedule, does not wait either. It only gets the first line described below.
- A link and a reference to the same issue count as the same home: `https://git.example.com/team/app/-/issues/12` and `team/app#12` match. A merge request (`team/app!12`) is a different home from the issue with the same number.
- When a run of an agent starts while another run of the same agent, in another chat, works on the same issue, the new run is told so in a first line that starts with `[agentx:same-home]`. It names the other run's chat and start time, and asks the agent to coordinate rather than redo or overwrite that work. The issue is taken from `home`, or from issue and merge request links and `group/project#12` references in the message. A bare `#12` is not used, because it names different work in every project.

Without `home`, each message starts its own session, as before.

### When the helper's run ends before the work does

Sometimes a helper ends its run to wait: for a build, a deploy, a monitor, or another agent. Its reply then is not the end of the work. The helper says so with the `agentx_waiting` tool before it ends the run, giving what it waits for (`on`) and, if it knows, when the wait should be over (`due`, an ISO time). The answer that comes back to the asking agent then says the work is **not finished** and what it waits for, with status `waiting`, instead of "finished". An open request stays "waiting on another agent", and a [task watcher](/automations/task-watchers) stays open until the work is marked done, due at that time. A request status comment that reads "waiting" turns done when that watcher is marked done, and timed out when it fires and the owner is told; with no watcher, it reads timed out once the due time (or `watchers.defaultDueMinutes` from the end of the run, if none was given) plus `watchers.escalateAfterMinutes` has passed.

The tool works only from inside the helper's own run (`POST /runs/waiting` on its own machine).

A `/mesh/task` request whose own `context` names a chat (`channel` and `chatId`) keeps its older behaviour. With `"async": true`, the helper's plain answer is posted to that chat, and no callback turn runs.

Some requests are refused straight away with status `409`:

- An agent asking itself.
- A request that could never start, because every slot of the target agent is held by a turn that is waiting on the asking agent. For example, A asks B, B asks A, and A can only run one task at a time. This is checked on one machine only.

## Check it worked

1. **Chat app:** ask your agent to get something from another agent, for example "ask the helper agent for today's build status".
2. Your agent replies straight away, saying who it asked.
3. A little later, your agent sends a second message with the helper's answer.
4. **Terminal:** on the machine that runs your agent, run:
   ```sh
   curl -s http://127.0.0.1:18800/a2a/delegations
   ```
   The newest entry names both agents and shows `"status":"done"`.

## If something is wrong

- **Your agent still waits for the helper:** check that `mesh.delegation.asyncWhenHuman` is not `false`. For the phone app, voice and dashboard chat, check that phone notifications are set up. Work started by a schedule or a workflow always waits.
- **The update never arrives:** open the daemon log and search for `[delegation`. A line ending in `no route to …` means the machine running your agent has no connection to that chat app; set the chat app up on that machine.
- **You get "did not answer in time":** the helper took longer than `mesh.delegation.timeoutMinutes`. Raise it, or ask for a smaller piece of work.
- **You get "was lost":** the machine restarted while the helper worked. Ask your agent to try again.
- **You get "could not pass on the answer … because of a restart":** AgentX restarted twice while your agent was passing the answer on, or the second try failed. Ask your agent for the answer again. If you track requests, the request shows what the helper said. In the daemon log, the lines starting `[delegation` with the reference from the message say what happened.
- **`409` with "cannot delegate to itself" or "could never answer":** the request would wait forever. Answer from what the agent already has, or raise the target agent's `maxConcurrent`.
- **The phone conversation gets no update:** the dashboard files it within a few seconds of the agent replying. Check that the dashboard is running (`agentx board serve`). For an agent on another machine, that machine must be up, and the dashboard needs a token for it: the shared mesh token (`MESH_TOKEN`), or its entry in `dashboard.daemons`. The update waits for the dashboard for up to a day, and is dropped if AgentX on that machine restarts first. Your agent still has it when you next ask. A dashboard log line starting `[app] warning:` means the dashboard passed over some updates: it was away too long, or too many arrived at once. Ask your agent for the answer again.
- **`agentx_send_agent` says "probably delivered":** the daemon took more than 10 seconds to confirm. Send the same message again; a repeat within 10 minutes returns the first task id instead of a second task. An agent that is busy with another task shows no trace until it starts the new one; search the daemon log for `[send/agent]` to see it was queued.
- **`/send` answers `"is not an a2a chat ID"`:** the `chatId` must look like `a2a:<agent>:<agent>`, optionally followed by `:<id>`. Copy it exactly as your agent was given it, or use `POST /send/agent` with `agentId`.
- **`/send` answers `"is not in a2a chat"`:** the `agentId` you sent is not one of the two agents in the `chatId`. Send as the agent the chat belongs to, or use `POST /send/agent`.
- **`agentx_send_agent` says "could not be reached":** the daemon on this machine is not running. Start it with `agentx daemon start --detach`, then send again.
- **The status list is empty:** only delegations since the last restart are listed, and only on the machine that runs the asking agent.
- **A follow-up started a new session anyway:** check that both messages named the same `home`, and went to an agent on the same machine. After a restart, or 12 hours after the last run ended, a new session starts. The daemon log line `is on … continues its session` shows when a session was continued. The line `a run on … is still going; starting a fresh session instead` means the earlier run outlasted the wait. Send the message after the earlier run ends. Raising `mesh.delegation.timeoutMinutes` (for a send, the agent's `maxExecutionMinutes`) rarely helps, because the earlier run usually has the same limit and started first.
- **Two runs still worked on the same issue:** the second one was told (its first line starts with `[agentx:same-home]`). If it went on anyway, tell the sending agent to name `home`, so the second message waits for the first run instead. Only an agent's message whose answer comes back as a new message waits. Any other run (a person's chat, a schedule, a queued send) never waits; only the first line warns it.
