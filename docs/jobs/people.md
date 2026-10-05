# Tell agents who is who

The same human can reach your agents in several places: a GitLab comment in the morning, a WhatsApp message in the afternoon. To AgentX these are two unrelated senders until you say they are one person. The `people` list does that: one entry per human, with the logins and numbers that belong to them.

Once a person is listed, every task they start is stamped with their id, whatever channel they used. You can then see everything one person asked for in one place.

Nothing changes until you add someone. With an empty list, what you do on your own machine (voice, the phone app, the dashboard) is recorded as the built-in person `owner`, and senders on other channels are unknown. Your own machine's surfaces vouch for you the way [open requests](./open-requests.md#turn-it-on) describes: a program that merely names one of those surfaces when it calls the daemon is not you.

## What a person is

| Part | What it means |
|---|---|
| id | A short name you choose, such as `sara`. Lower-case letters, digits, `-` and `_`. |
| name | Their name as you want to read it. |
| role | `owner`, `member`, `client` or `guest`. `owner` is you (see below). `member` is a teammate. `client` is someone you do work for: their paired machine opens [Your project](./clients.md) instead of a teammate's [My work](./members.md). `guest` is the operator of another organisation's mesh. Beyond the page a person sees, only `owner` changes what their messages may do. |
| identities | Where they write from, each as `channel:id`: `gitlab:sara.b`, `github:sara-b`, `telegram:123456789`, `whatsapp:21620123456`. |
| agents | The agents this person may reach, by id. Empty, the default: every agent. See [Limit which agents a person can reach](#limit-which-agents-a-person-can-reach). |
| deny | Tools and skills this person's work may not use. Empty, the default: no limit. See [Stop a person using some tools or skills](#stop-a-person-using-some-tools-or-skills). |

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

## Add a client

A client is someone you do work for, not a teammate.

1. **Terminal:** run `agentx people add acme --name "Acme Bakery" --role client --identity whatsapp:21620123456`.
2. Run `agentx people list` to read the result: the line ends with `· client`.

A client's messages are matched and limited the same way as a teammate's. What differs is the page they can be given: **Your project**, their own requests in plain words and nothing about your agents. See [Give a client a page of their own](./clients.md).

## See what a person asked for

In the dashboard, the [People](../dashboard/people.md) tab lists everyone; click a person to see their requests, their latest tasks and the machines they paired. From a terminal:

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

## Stop a person using some tools or skills

A **tool** is one thing an agent can do during its work: run a terminal command (`Bash`), fetch a web page (`WebFetch`), or call a connected service such as a mail account (tool names that start with `mcp__`). A **skill** is a packaged set of instructions the agent can load, such as a deploy checklist.

By default a listed person's work can use every tool and skill the agent has. To take some away from one person:

1. **Terminal:** run `agentx people deny sara tools Bash WebFetch`. Sara's work can no longer run terminal commands or fetch web pages, whichever agent does it.
2. **Terminal:** run `agentx people deny sara skills deploy`. Her work can no longer load the `deploy` skill, and that skill is not offered to the agent for her messages.
3. Run `agentx people list` to read the result: Sara's line ends with `no tools: Bash, WebFetch · no skills: deploy`.
4. To lift one level, run `agentx people deny sara tools none` (or `skills none`).

Names match without regard to upper or lower case. A `*` stands for anything: `agentx people deny sara tools "mcp__mail__*"` covers every action of the mail connection. Put a name with `*` in quotes so the terminal leaves it alone.

What happens when the agent reaches for a denied tool or skill:

- The call is blocked before it runs. The agent is told *Sara B may not use Bash here (set by the owner)*, finishes what it can without it, and says in its answer what was not done.
- The block is written to the guard log (`agentx guard log`) and to `.agentx/members-log.jsonl` with the person and the tool.
- This is a hard limit, not an instruction: AgentX checks every tool call of that run. If the check cannot be made, for example because the daemon is not reachable, the call is blocked rather than let through.

What the limit does not cover:

- An owner is never limited; `agentx people deny` refuses one.
- It works on agents of the `claude-code` tier. A message from a limited person to an agent of another tier does not run: the reply is an error that says the limits cannot be enforced on that tier, because it cannot be checked call by call.
- A limited person's message never goes to your own Claude Code session ([Work from your Claude Code session](/jobs/claude-code-session)), which runs outside the check. It runs as a normal task instead.
- A hand-off to an agent on another node that carries only the message (an agent-to-agent hand-off that waits for its answer) is refused, since that node could not apply the limit. A message forwarded from a channel carries who wrote it; that node applies its own people list. Give the person the same `id` and the same `deny` on every node they write to.
- The rest of the list under [Limit which agents a person can reach](#limit-which-agents-a-person-can-reach) applies here too: unknown senders, workflows and scripts calling the API are not tied to a person.

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

To check a tool limit:

1. **Terminal:** run `agentx people deny sara tools Bash` for a test teammate.
2. From that teammate's account, ask an agent to run a terminal command, such as listing a folder.
3. The agent answers that it was not allowed to run it.
4. **Terminal:** run `agentx guard log`. The newest line names the tool and the rule `people.deny`.

## If something is wrong

- **The task is not in the list:** the sender did not match. Run `agentx people list` and compare the identity with the login, id or number on that channel. On Telegram use the numeric id if the username does not match.
- **`identity … belongs to both`:** the login or number is already on another person. Run `agentx people unlink <id> <channel:id>` on the first one.
- **`write it as channel:id`:** the identity has no channel in front. Write `gitlab:sara.b`, not `sara.b`.
- **Tasks on voice or the dashboard have no person:** two people have the `owner` role. Keep one owner and make the other a `member`.
- **`--role must be one of: owner, member, client, guest`:** the role was mistyped. Use one of those four words.
- **A denied tool still ran:** the message did not match the person, so no limit applied. Check with `agentx people show <id>` that the task is listed under them. Also check the spelling of the tool: `agentx guard log` shows the exact names agents use.
- **Every tool call is blocked for a limited person:** the check could not reach the daemon. Run `agentx daemon status` and start the daemon if it is not running.
- **`level must be one of: tools, skills`:** write `tools` or `skills` right after the person's id.
