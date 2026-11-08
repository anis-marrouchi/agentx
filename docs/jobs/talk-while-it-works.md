# Talk to an agent while it works

You ask an agent for something, it starts working, and a moment later you notice it is going the wrong way: the wrong file, the wrong client, a step you did not want. Before, your next message waited until the agent had finished everything, so the correction came after the work it was meant to stop.

Now a message you send in the **same conversation** while the agent is working reaches it during that work. The agent reads it after its next step (the next command, file edit or tool it uses), changes course if needed, and says in its answer that it saw your message.

## How it works

1. You send a message to an agent that is already working in that conversation, from the phone app, a chat app (Telegram, WhatsApp, GitLab and others), voice, or the **Update** button on a running task in the Hub.
2. AgentX gives the message to the run that is working.
3. After that run's next step, the agent reads it, with the time and who sent it.
4. The agent's answer covers your message. Your message does not start a second, separate turn.
5. If the agent finishes before it takes another step, your message is handled as before: it runs as the next turn.

On the phone app, a message read this way gets the reply "Delivered into the run that was already working in this chat". The answer you are waiting for comes from the run that was working.

## What it applies to

- Agents that run on Claude Code (tier `claude-code`).
- Messages in the same conversation as the running work. A message in another conversation does not reach that run.
- Messages from people and from other agents. Internal turns (a step of a request's plan, a schedule, a workflow) never interrupt a run this way.

To stop the agent instead of correcting it, use **Stop** as before.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `session.midTurnMessages` | `true` | Messages that arrive while an agent works in the same conversation are read by that run after its next step. `false` keeps the old behaviour: they wait for the next turn. |

The agent reads the messages through a hook that AgentX adds to the agent's workspace (`.claude/settings.json`, a `PostToolUse` entry that calls `/runs/inbox` on this computer). It is added or updated each time AgentX starts.

## Check it worked

1. **Phone app:** ask an agent for something that takes a few steps, for example "list the files in your workspace one folder at a time and describe each".
2. **Phone app:** while it is working, send "stop after the second folder".
3. The agent's answer stops after the second folder and mentions your message.
4. **Terminal:** search the daemon log for `read 1 message(s) mid-turn`. It names the agent and the conversation.

## If something is wrong

- **The agent finished everything and then answered your second message separately:** it took no further step after your message arrived, so your message ran as the next turn, as before.
- **Nothing in the log about mid-turn messages:** check that the agent's tier is `claude-code`, that `session.midTurnMessages` is not `false`, and that the agent's `.claude/settings.json` has a `PostToolUse` entry containing `/runs/inbox`. Restart AgentX to add it.
- **The phone app shows "Delivered into the run that was already working" but no answer follows:** the run that was working may have ended in an error. Look at the task in the Hub, then send your message again.
