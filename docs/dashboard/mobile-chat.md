# Chat on your phone

The **Chat** tab of the [phone app](./mobile-app.md) lets you talk to any agent on this computer, or on another computer linked to it in your *mesh* (the private link between your AgentX computers, see [Add a second machine](../jobs/second-machine.md)). The answer appears as the agent writes it. Each conversation stays with the agent you started it with, and the agent remembers the earlier messages in it.

![An answer with the tools the agent used, a link button and a poll](/screenshots/mobile-app/chat.png)

## Before you start

- Install and pair the [phone app](./mobile-app.md).
- AgentX is running on the computer the phone is paired with.

## Start a conversation

1. **Phone:** open the app and tap **Chat**.
2. **Phone:** tap **Choose an agent**. The list shows each computer with a green dot when it is online, and each agent as **idle** or **busy**. Agents on an offline computer can't be picked.
3. **Phone:** tap an agent.
4. **Phone:** type your message and tap **Send**. The answer appears under your message as the agent writes it.

![Choosing an agent: every computer, whether it is online, and whether each agent is busy](/screenshots/mobile-app/chat-picker.png)

If the agent is busy with other work, your message waits until the agent is free, then runs.

## While the agent answers

- **See the tools it used:** tap the grey line above the answer, for example **2 tools · Bash (npm test)**. A tool that failed is marked in red.
- **Stop it:** tap **Stop**. The agent stops, and what it wrote so far is kept.
- **Add to your request:** type another message and tap **Send**. It shows as *Sent when the agent finishes* and goes to the agent as soon as the current answer ends.

Leaving the app or losing the connection while the agent answers also stops it.

![An answer being written, with the Stop button](/screenshots/mobile-app/chat-streaming.png)

## Buttons, polls and pictures

Some answers come with extras: link buttons, a small poll, or a picture, sound or video. Links open in the phone's browser. Tapping a poll answer sends it to the agent as your next message.

Agents add these on their own. To turn them off for one agent, set `richMessages` to `false` in its [agent settings](../reference/config-agents.md).

## Go back to a conversation

1. **Phone:** tap **History**.
2. **Phone:** tap the conversation. Its messages appear, and your next message continues it with the same agent.

To start over with the same agent, tap **New**.

![History lists your conversations, newest first](/screenshots/mobile-app/chat-history.png)

Conversations are saved on the computer (in `.agentx/db.sqlite`, next to `agentx.json`) and on the phone. Each phone sees only its own conversations. The computer keeps the 100 most recent conversations per phone and the last 200 messages of each, and shortens a very long answer (the full answer stays in the agent's task history). With no connection, **History** still opens the conversations saved on the phone, but you can't send messages.

## Check it worked

1. **Phone:** tap **Chat**, then **Choose an agent**. Your computers and their agents are listed.
2. **Phone:** pick an agent, type `hello`, and tap **Send**. The agent's answer appears under your message.
3. **Phone:** tap **History**. The conversation is listed with the agent's name.

## If something is wrong

- **"No machines answered"** — AgentX isn't running on the computer, or the dashboard can't reach it. On the computer, run `agentx daemon status`.
- **A computer is listed as "Not linked to this computer’s mesh"** — the dashboard can see it, but this computer can't pass messages to it. Link the two computers as in [Add a second machine](../jobs/second-machine.md), then check with `agentx mesh list`.
- **A computer is listed as offline** — it is turned off, or its connection dropped. On this computer, check it with `agentx mesh list`.
- **"The agent is still answering in this conversation"** — a message is already running there, maybe from another screen. Wait for it to finish, or tap **Stop**.
- **"The agent is busy with other work"** — the other computer runs an older AgentX. Send the message again when the agent is free, or update AgentX there.
- **"Could not reach AgentX"** — the phone lost its connection. Reconnect and send the message again.
- **"The database on this computer is unavailable"** — AgentX can't open `.agentx/db.sqlite`. On the computer, run `agentx doctor`.
