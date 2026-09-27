# Hand due reminders back to agents

On a Mac, an agent can park work for later as an Apple Reminder: "retry the deploy on Monday", "check the client's reply tomorrow". When a reminder falls due, AgentX gives the task back to the agent that created it, so the follow-up happens without anyone asking.

This works only on macOS. Other machines ignore the setting.

## How it fits together

An agent creates the reminder with a skill (for example one that calls `remindctl`). The reminder's notes end with one line saying who created it, called the **trailer**:

```
agentx: agent=<agent-id> context=<channel>:<chat-id>
```

- `agent` is the agent that gets the task back. It must be an agent on this Mac.
- `context` is optional: where the work came from, for example `telegram:123456`. The agent's answer is sent there.
- The reminder's title is the task. The notes above the trailer are the details.

Every minute, the daemon reads the lists you choose. For each reminder that is due and not done:

1. It records the reminder as handed over, so a restart never hands it over twice.
2. It sends the agent a task with the title and the details, starting with `[Reminder due <time> · id <id>]`.
3. Once the agent has started (or queued) the task, it ticks the reminder off in Reminders.
4. When the agent answers, the answer goes to the `context` chat. With no `context`, or one AgentX can't send to, it goes to `notifications.destination`.

If the task can't start (for example, the hourly [dispatch cap](/reference/config-agents#session) is reached), the reminder stays open and is tried again later, waiting longer each time, up to an hour.

Reminders without a trailer, or for an agent that isn't on this Mac, are left alone and noted once in the log.

If the daemon was off and a reminder is overdue by more than `lookbackHours` (24 by default), it isn't run. The agent gets one message listing such reminders, and they stay open for it to decide.

## Before you start

- A Mac running the AgentX daemon.
- `remindctl` installed. **Terminal:**
  ```sh
  brew install steipete/tap/remindctl
  ```
- A Reminders list for agents, for example `AgentX`.

## 1. Turn it on

1. **Terminal:** in the folder with `agentx.json`, run:
   ```sh
   agentx config set reminders.enabled true
   ```
2. To watch other lists, set them. For example:
   ```sh
   agentx config set reminders.lists '["AgentX","Follow-ups"]'
   ```

The daemon picks up the change without a restart. All settings are in the [configuration reference](/reference/config-automation#reminders).

## 2. Allow access to Reminders

The first time the daemon reads Reminders, macOS asks whether it may. Only the Mac's owner can answer.

1. **Mac:** when the prompt appears, click **Allow** (or **OK**).
2. If you missed it: open **System Settings › Privacy & Security › Reminders** and turn on the program running the daemon (for example `node` or your terminal).
3. **Terminal:** check the access:
   ```sh
   remindctl status
   ```
   It prints `Reminders access: Full access`.

## Check it worked

1. **Terminal:** run `agentx doctor`. Under **Reminders** you see `Watching AgentX for due reminders`.
2. **Terminal:** add a test reminder that was due a minute ago, for an agent on this Mac:
   ```sh
   remindctl add --title "Say hello" --list AgentX --due "$(date -v-1M '+%Y-%m-%d %H:%M')" \
     --notes $'Test of the hand-back.\n\nagentx: agent=<agent-id>'
   ```
3. Wait up to a minute. **Terminal:** `remindctl show all --list AgentX` no longer shows it; it is ticked off.
4. **Dashboard:** open **Tasks**. The agent has a task on the `reminder` channel that starts with `[Reminder due`.
5. The daemon log has a line `[reminders] <id> "Say hello": dispatched to <agent-id>`.

## If something is wrong

- **The log says `only available on macOS`:** this machine isn't a Mac. Turn the setting on on the Mac instead.
- **`agentx doctor` says `remindctl not found`:** install it, or set `reminders.command` to its full path. The daemon may run with a shorter `PATH` than your terminal.
- **The log says `can't read list`:** the list name doesn't match, or access was refused. Check the name with `remindctl list`, and access with `remindctl status`.
- **A reminder is never picked up:** it has no trailer, or its agent isn't on this Mac. The log says which, once per reminder. Also check that it has a due date and is in a watched list.
- **A reminder stays open and the log says `refused`:** the task couldn't start, often because the dispatch cap is reached. It is tried again automatically.
- **The answer didn't reach the chat:** the `context` must name a connected channel and a chat ID on it. Otherwise the answer goes to `notifications.destination`; with neither, it stays in the agent's session.
- **A task was cut off by a restart:** the reminder is already ticked off and isn't handed over again. The restart report lists the run on the `reminder` channel.
