# Tell agents who is who

The same human can reach your agents in several places: a GitLab comment in the morning, a WhatsApp message in the afternoon. To AgentX these are two unrelated senders until you say they are one person. The `people` list does that: one entry per human, with the logins and numbers that belong to them.

Once a person is listed, every task they start is stamped with their id, whatever channel they used. You can then see everything one person asked for in one place.

Nothing changes until you add someone. With an empty list, what you do on your own machine (voice, the phone app, the dashboard) is recorded as the built-in person `owner`, and senders on other channels are unknown. Your own machine's surfaces vouch for you the way [open requests](./open-requests.md#turn-it-on) describes: a program that merely names one of those surfaces when it calls the daemon is not you.

## What a person is

| Part | What it means |
|---|---|
| id | A short name you choose, such as `sara`. Lower-case letters, digits, `-` and `_`. |
| name | Their name as you want to read it. |
| role | `owner`, `member` or `guest`. Today the role is a label; only `owner` has an effect (see below). Access rules per role come later. |
| identities | Where they write from, each as `channel:id`: `gitlab:sara.b`, `github:sara-b`, `telegram:123456789`, `whatsapp:21620123456`. |
| agents | The agents this person may reach, by id. Empty, the default: every agent. See [Limit which agents a person can reach](#limit-which-agents-a-person-can-reach). |

Which value to use on each channel:

| Channel | Use |
|---|---|
| GitLab, GitHub | The login (the part after `@`). |
| Telegram | The numeric user id, or the username. |
| WhatsApp | The phone number with its country code. Spaces and `+` are ignored. |

Display names are never matched, because anyone can choose one. A sender that matches nobody stays unknown; AgentX does not guess.

## Add yourself

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx people add anis --name "Anis" --role owner --identity telegram:123456789`. Use your own id, name and Telegram id.
3. Add each other place you write from: run `agentx people link anis github:your-login`.
4. Run `agentx people list` to read the result.

The running daemon picks the change up at once. If it is not running, the change applies at the next start.

With one owner listed, your messages on those channels count as yours for [open requests](../reference/config-automation.md#requests) too. You no longer need the same values in `requests.from`.

## Add a teammate

1. **Terminal:** run `agentx people add sara --name "Sara" --identity gitlab:sara.b`. The role is `member` unless you give `--role`.
2. Run `agentx people link sara "whatsapp:+216 20 123 456"` to add their WhatsApp number.

Each identity belongs to one person. Giving the same login or number to a second person is refused.

A listed teammate can also get a small window of their own, **My work**, that shows what they asked for and where it stands: see [Invite a teammate to their work page](./members.md).

## See what a person asked for

1. **Terminal:** run `agentx people show sara`.
2. You see the person, their open requests if you use them, and their latest tasks with the time, channel, agent and first words. GitLab and WhatsApp tasks appear in the same list.

Add `--limit 50` for a longer list, or `--json` for a script.

## Limit which agents a person can reach

By default a listed person can write to any agent, like before. To limit them:

1. **Terminal:** run `agentx people allow sara coder-agent pm-agent`. Use the agent ids from `agentx agents`.
2. From then on a message from Sara to any other agent is answered with one line: *Sara B, you can reach coder-agent, pm-agent here, not devops-agent. Ask the owner if you need devops-agent.* No run starts, nothing is queued. This holds for an agent on another node too: the message is refused here and never leaves.
3. The limit follows her work: an agent working for her cannot hand it to an agent she may not reach either, on this node or on another. The agent that asked is told why, and the refusal is in her trail. A hand-off to another node that names no agent is refused as well, since that node would pick the agent.
4. To lift it, run `agentx people allow sara all`.

You can also set it when adding someone: `agentx people add sara --name "Sara B" --agent coder-agent`.

Each refused message is written to `.agentx/members-log.jsonl` with the person and the agent, and kept as long as the rest of that file ([Invite a teammate to their work page](/jobs/members)).

What the limit does not cover:

- An owner is never limited; `agentx people allow` refuses one.
- Unknown senders are not limited here; each channel decides whether it answers them at all.
- A workflow's agent steps run whoever triggered the workflow.
- Work handed on from another node: once an allowed agent on a peer has her work, that peer applies its own people list, not this one. It can do so only when it knows the work is hers: a message forwarded from a channel carries who wrote it; a hand-off between agents that waits for its answer does not, and the peer then applies no limit.
- An agent answered by your own Claude Code session ([Work from your Claude Code session](/jobs/claude-code-session)): when your session takes her message for an allowed agent, what it then asks of other agents is not checked. You are at that terminal; you decide.
- A request to the daemon's API that does not name the turn it comes from (a script calling `/task` directly) is not tied to a person.
- The command warns when an id is not an agent on this machine. Check the spelling: a mistyped id leaves the person able to reach nothing.
- With several nodes, each node reads its own people list. Give a person the same `id` and the same limit on every node they write to.
- Limits per tool and per skill are not built yet.

## Change or remove

- **Take an identity away:** `agentx people unlink sara gitlab:sara.b`.
- **Remove a person:** `agentx people remove sara`. Their past tasks keep the id `sara`. New messages from them are unknown.

You can also edit `people` in `agentx.json` by hand; the fields are in the [configuration reference](../reference/config-agents.md#people).

## What is not stamped

- Work that software starts: scheduled jobs, workflows, and a comment an agent posts with your GitLab or GitHub account.
- A second owner at your own machine. With two people in the `owner` role, AgentX cannot tell who is speaking to the Mac or using the dashboard, so those tasks have no person. Messages on Telegram, WhatsApp, GitLab and GitHub are still matched.
- Tasks from before you listed the person.

When an agent hands work to another agent, or to an agent on another machine, the person's id goes with it. The other machine keeps the id even when its own list does not have that person.

## Check it worked

1. Send a message to an agent from a channel you listed.
2. **Terminal:** run `agentx people show <your id>`.
3. The message is in the list of latest tasks, with the channel you used.

## If something is wrong

- **The task is not in the list:** the sender did not match. Run `agentx people list` and compare the identity with the login, id or number on that channel. On Telegram use the numeric id if the username does not match.
- **`identity … belongs to both`:** the login or number is already on another person. Run `agentx people unlink <id> <channel:id>` on the first one.
- **`write it as channel:id`:** the identity has no channel in front. Write `gitlab:sara.b`, not `sara.b`.
- **Tasks on voice or the dashboard have no person:** two people have the `owner` role. Keep one owner and make the other a `member`.
