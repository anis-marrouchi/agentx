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

The update needs a way back to you:

- Chat apps, GitLab and GitHub: the update is posted in the same chat or thread.
- Phone app, voice and dashboard chat: the update arrives as a phone notification. This needs [phone notifications](../dashboard/mobile-alerts.md) set up. Without them, your agent waits for the helper's answer as before.

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

A request made from a shell can name its turn with the header `X-AgentX-Task: $AGENTX_TASK_ID`. Add `"async": false` to the request body to wait for the answer anyway, or `"async": true` to get the callback from a scheduled turn as well.

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
- **The status list is empty:** only delegations since the last restart are listed, and only on the machine that runs the asking agent.
