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

A GitLab or GitHub comment written by an agent does not count as a person's, even when it was posted with a person's account. AgentX recognises these comments by the hidden AgentX signature at the end, or by the "🤖 **agent-name** (via AgentX)" line at the top. Every comment AgentX posts carries the signature.

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

Add `"async": false` to the request body to wait for the answer anyway. Add `"async": true` to get the callback from a turn no person started, such as a schedule. `"async": true` has no effect inside a delegation: a turn that is itself answering another agent, or a turn that carries a delegation result, always waits. This stops one callback from starting another.

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
- **`409` with "cannot delegate to itself" or "could never answer":** the request would wait forever. Answer from what the agent already has, or raise the target agent's `maxConcurrent`.
- **The phone conversation gets no update:** the dashboard files it within a few seconds of the agent replying. Check that the dashboard is running (`agentx board serve`). For an agent on another machine, that machine must be up, and the dashboard needs a token for it: the shared mesh token (`MESH_TOKEN`), or its entry in `dashboard.daemons`. The update waits for the dashboard for up to a day, and is dropped if AgentX on that machine restarts first. Your agent still has it when you next ask.
- **The status list is empty:** only delegations since the last restart are listed, and only on the machine that runs the asking agent.
