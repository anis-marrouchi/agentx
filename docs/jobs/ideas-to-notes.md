# Get agents' ideas in Apple Notes

Agents sometimes have an idea for you that is neither a question nor a task, for example "a weekly digest of client replies would save you time". Instead of a chat message you have to keep track of, an agent can write it as a note in **Apple Notes**, in a folder called **AgentX**. You read them when you have time, on your Mac, iPhone or iPad.

It is off by default.

## What it does

- Agents get a tool, `agentx_note`, with a title (up to 120 characters) and a body (up to 4,000).
- The note goes into the folder **AgentX**, which is created the first time. It ends with a line naming the agent and the time, for example `— scout, 2030-03-01T08:00:00.000Z`.
- Each agent can add at most 10 notes a day. After that the tool says the limit is reached, until the next day.
- AgentX only writes notes. It never reads, changes or deletes them.
- A note can only come from an agent's running task, not from other programs on the machine.
- **Several machines:** a machine without Apple Notes (a Linux server, for example) sends the note to your Mac over the mesh. It uses the peer named in `native.forwardTo`, or `approvals.forwardTo` when that is unset. Turn notes on on both machines; the Mac's daily limit applies too. The Mac accepts a note only from a peer that uses its own token in `mesh.peers` (the same rule as forwarded approval cards), and only for that peer's agents.

## Before you start

- A Mac running the AgentX daemon, signed in to the Notes account you want the folder in. The folder is made in Notes' default account.

## 1. Turn it on

1. **Terminal:** in the folder with `agentx.json`, run:
   ```sh
   agentx config set native.notes.enabled true
   ```
2. Optional: `agentx config set native.notes.folder "Ideas"` uses another folder, and `agentx config set native.notes.perAgentPerDay 5` changes the daily limit (1 to 50).

The daemon picks up the change without a restart. All settings are in the [configuration reference](/reference/config-automation#native).

## 2. Allow AgentX to use Notes

The first note asks macOS whether the program running the daemon may control Notes.

1. **Mac:** when the prompt appears, click **OK**.
2. If you missed it: open **System Settings › Privacy & Security › Automation**, find the program running the daemon (for example `node` or your terminal), and turn on **Notes**.

## Check it worked

1. Ask an agent, in any channel: "Use agentx_note to write me a test idea."
2. The agent says it was added to the folder **AgentX**.
3. **Notes:** the folder **AgentX** has the note, signed with the agent's id.
4. The daemon log has a line `[notes] <agent> added a note`.

## If something is wrong

- **The agent says `notes are off on this node`:** turn it on on the machine the agent runs on (step 1). With several machines, turn it on on both.
- **The agent says `this machine has no notes app`:** the agent runs on a machine without Apple Notes, and no peer is set. Set `native.forwardTo` to the name of your Mac in `mesh.peers`.
- **The agent says `could not add the note`, with `not allowed`:** follow step 2, then ask again.
- **The agent says the limit is reached:** it already added `perAgentPerDay` notes today. Raise the limit, or wait until tomorrow.
- **The agent says `only an agent's running turn can add a note`:** the call did not come from an agent's task. Notes can't be added from scripts.
- **A note forwarded from another machine is refused with `only an agent's running turn`:** the Mac does not recognise the other machine's token. Give that peer its own `token` in `mesh.peers` on both machines.
