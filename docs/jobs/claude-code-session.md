# Work from your Claude Code session

If you already have a Claude Code session open (the terminal where you chat with Claude while you code), AgentX can connect to it. This is called **attaching**. There are two ways to attach:

| Way | Command | What your session does |
|---|---|---|
| Answer as an agent | `agentx attach as <agent>` | Messages for that agent come to your session instead of starting a separate run. Your session answers them. |
| Watch | `agentx attach watch` | Your session answers for no agent and receives no messages. Each time you send a prompt, it gets a short list of what happened since your last prompt. |

Use **watch** when you want to stay aware of what your agents and machines are doing without taking over any of their work.

## Before you start

1. **Terminal:** run `agentx attach install` once. It adds small helpers to Claude Code's settings (`~/.claude/settings.json`) that tell AgentX when a session starts, when you send a prompt and when Claude finishes a reply. These helpers are called **hooks**.
2. Start a new Claude Code session, or restart the one you have, so it loads the hooks.

## Answer as an agent

1. **Claude Code:** ask Claude to run `agentx attach as helper` (use your own agent's name).
2. Messages for `helper` now wait in your session. You are told when they arrive; run `/inbox` to answer them.
3. **Claude Code:** to stop, ask Claude to run `agentx attach detach`.

The full list of options, including the three delivery modes (`manual`, `notify`, `auto`), is in the [CLI reference](/reference/cli-commands#attach).

## Watch without answering

A watching session:

- never receives messages. A message for any agent is handled by that agent as usual.
- never continues on its own after Claude finishes a reply.
- gets one short list, called a **digest**, added to each prompt you send. It lists the events since your previous prompt. An event is one short record of something that happened, such as an agent finishing a task. The [events reference](/reference/events) lists them all.

By default the digest includes:

| What | Events |
|---|---|
| Finished agent tasks, including failed ones | `task:completed` |
| Workflow runs that failed, timed out or completed | `failed`, `timeout`, `completed` |
| Workflow runs waiting for a person to approve | `paused` at a checkpoint |
| Machines that stopped answering | `lost` |

The digest is short on purpose: at most 15 lines and 1,500 characters. When more events happened, it shows the newest ones and ends with a line such as `+42 more — agentx events --since <event-id>`. Run that command in a terminal to see the rest.

To start watching:

1. **Claude Code:** ask Claude to run `agentx attach watch`. It prints `This session is now watching`.
2. **Claude Code:** keep working. When something matching happens, your next prompt carries the digest, and Claude can tell you about it.

To follow other events, name them. Each value is an event kind or type from the [events reference](/reference/events#kinds-and-types):

```sh
agentx attach watch --kinds task:completed,lost --agents helper,reviewer
```

`--agents` keeps only events about those agents. `--match <text>` keeps only events whose summary contains that text. If you give `--agents` or `--match` without `--kinds`, every kind is included.

To stop watching:

1. **Claude Code:** ask Claude to run `agentx attach detach`.

Watching survives a daemon restart. It ends when you run `agentx attach detach`, when you run `agentx attach as <agent>` in the same session, or when you close the session.

## Check it worked

1. **Terminal:** run `agentx attach list`. Your session appears under **Watchers**, not under **Identities**.
2. **Terminal:** send an agent a task, for example `agentx daemon send helper "Reply with a short hello"`.
3. **Claude Code:** when the agent has answered, send any prompt, for example "anything new?". Claude mentions a `task:completed helper@<machine>` event.
4. **Claude Code:** send another prompt. Nothing new is mentioned, because each event is shown once.

## If something is wrong

- **`Attach hooks are not installed yet`:** run `agentx attach install` in a terminal, then restart the Claude Code session.
- **`Could not determine the Claude Code session id`:** the command ran outside Claude Code. Ask Claude to run it, or pass `--session <id>` (find the id with `agentx attach list`).
- **`daemon not reachable`:** start AgentX with `agentx daemon start --detach`. While the daemon is stopped, a watching session simply gets no digest; Claude Code shows no error.
- **No digest ever appears:** only events on this machine are included, and the list starts empty after a daemon restart. Run `agentx events` to see what the machine has. If those events don't match the default list, name them with `--kinds`.
- **The digest is always cut short:** a lot is happening. Narrow it with `--kinds`, `--agents` or `--match`, or run the `agentx events --since` command on its last line.
- **The session answers messages again:** someone ran `agentx attach as <agent>` in it, which ends watching. Run `agentx attach watch` again.
