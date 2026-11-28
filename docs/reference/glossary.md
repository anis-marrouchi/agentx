# Glossary

Words used across these docs, in plain terms.

| Term | Meaning |
|---|---|
| **A2A** | Agent-to-agent: one agent handing a task to another, on the same machine or another one. It is also the name of an open standard for agents talking to each other. See [A2A](./a2a.md). |
| **Activity** | The recorded history of work and routing decisions. See [Activity](../dashboard/activity.md). |
| **Agent** | An AI assistant that does work for you. It has a workspace, written instructions, and a model. Some pages say *AI helper*, *AI worker* or *AI teammate*: they all mean an agent. |
| **AgentX Helper** | A separate small Mac app that shows AgentX notification banners with the AgentX logo. It is not the voice assistant. See [Get notified](../jobs/notifications.md). |
| **AgentX Voice** | The voice assistant for your Mac: hold a key, speak, and an agent answers out loud. Some pages call it the *desktop assistant*, and you install it with `agentx desktop install`. Older installs named the app **AgentX Desktop**. All of these mean AgentX Voice. See [AgentX Voice](../guides/agentx-voice.md). |
| **API key** | A secret code from a model provider, such as Anthropic, that lets AgentX use that provider's models. The provider bills the account the key belongs to. Keep it private, like a password. |
| **Automation** | Work AgentX starts on its own, without anyone sending a message: a schedule, or a workflow that starts on a timer or an event. |
| **Canned reply** | A fixed, pre-written reply. The demo (`agentx demo`) uses canned replies instead of a real model, so it costs nothing. |
| **Channel** | A connection that carries messages in from, and replies out to, a tool such as Telegram or GitLab. See [Channels](./channels.md). |
| **Cron** | The timing format behind a schedule, such as `0 9 * * 1-5` for 9:00 on weekdays. *Cron job* is another word for a schedule, and `agentx.json` keeps schedules under `crons`. See **Schedule**. |
| **Daemon** | The AgentX background service that receives work and runs agents. |
| **Dashboard** | The separate browser server for setup and inspection. See [The dashboard](../dashboard/index.md). |
| **Desktop assistant** | Another name for AgentX Voice. See **AgentX Voice**. |
| **Jev** | An optional decision model that answers small typed questions (yes or no, pick one of these) for AgentX, often faster and cheaper than the agent's main model. The main model still does the open-ended work. See [Jev and typed decisions](../architecture/jev.md). |
| **Ledger** | Short for the *intent ledger*: AgentX's record of incoming work and the decisions made about it, such as which agent it went to and how it ended. See it at `/admin/ledger` on the dashboard or with `agentx ledger`. The *fact ledger* is a different list: the facts agents learned ([review what agents learn](../jobs/agent-memory.md)). |
| **Loopback** | The computer talking to itself. An address such as `127.0.0.1` or `localhost` can only be reached from the same computer. AgentX trusts requests that arrive this way, which is why the dashboard asks for no login on the computer itself. |
| **MCP** | Model Context Protocol, a standard way for AI tools to call outside tools. `agentx serve --stdio` offers AgentX to editors this way. |
| **Mesh** | Your connected machines that run AgentX and can hand work to one another. One machine on its own is a mesh of one. |
| **Node** | One machine running AgentX. In the mesh, each machine is a node. |
| **Peer** | Another node that this node is connected to in the mesh. |
| **Provider** | The company or tool that supplies the model, such as an API key account or a signed-in CLI. |
| **Review** | The check AgentX runs after a task finishes to write down what is left to do. Its results appear in [Monitor](../dashboard/monitor.md). |
| **Routine** | Another word for a schedule. The Hub's **Schedules** page lists schedules (see [Schedules](../dashboard/hub.md#see-recurring-jobs-and-their-value-line)). See **Schedule**. |
| **Run** | One time an agent works: it takes one message (or a wake), works on it and answers. A run has its own steps, cost and record in **Activity**. A workflow's runs are called *workflow runs*. See [Request, job, session, run and turn](#request-job-session-run-and-turn). |
| **Schedule** | Work that starts at set times by itself, such as a summary every Friday. Also called a *scheduled job*, *cron job* or *routine*. `agentx schedule` and `agentx cron` manage them. |
| **Seat** | One named kind of small question AgentX can hand to a decision model (Jev), such as "which on-screen control matches this description?". Each seat can be off, watching only, or active. |
| **Tier** | An agent's engine: `claude-code`, `codex-cli`, `opencode`, `antigravity-cli` (Google's `agy`), `sdk` (Anthropic API key) or `orchestrator` (any provider). The dashboard calls it **AI engine**. |
| **Token** | A secret code that proves a program or machine may use something, like a password for programs. AgentX uses several: the *mesh token* that lets your machines trust each other, the dashboard token (`dashboard.token`), scoped tokens from `agentx token`, and the tokens channels such as Telegram give you. Never share or paste one in public. |
| **wacli** | A separate WhatsApp command-line tool. AgentX uses it to read watched WhatsApp chats and send the replies you approve. See [Watch a WhatsApp chat](../jobs/watch-whatsapp.md). |
| **Workflow** | A saved automation with steps. See [Workflow schema](./workflow-schema.md). |
| **Workspace** | An agent's own folder on the computer. It holds the agent's instructions and the files it works on. Set it with `workspace` in the agent's settings. |

For commands and accepted configuration, see the [CLI](./cli.md) and [configuration](./config.md) references.

## Words in the code

These words come up in the code, in issues and in pull requests. Each has one plain line and the place under `src/` where it lives. To see how the parts connect, read [How AgentX fits together](../architecture/overview.md): its picture follows one message from arrival to reply.

| Word | Meaning | Where it lives |
|---|---|---|
| **Adapter** | The code for one channel, such as Telegram, that turns its messages into one shape and sends replies back. | `src/channels/telegram.ts`, `src/channels/whatsapp.ts`, … |
| **Admission queue** | Where a run waits when the machine has no free slot. Long waits post a short "waiting" note in the chat. | `src/admission/` |
| **Delegation** (hand-off) | One agent giving part of a job to another agent and getting a callback when it is done, so the person is not kept waiting. | `src/a2a/delegation.ts` |
| **Desk** | One board of what waits for the owner, what runs and what ended. A *Desk card* is one item on it, often a question for the owner. | `src/desk/`, `src/approvals/` |
| **Engine** | The program that runs an agent's turn: Claude Code, Codex, OpenCode, the Anthropic SDK or the orchestrator. Same as **Tier**. | `src/agents/runtime.ts` |
| **Event** | A short record that something happened (a run ended, a request closed). Agents and pages subscribe to events. | `src/events/` |
| **Goal** | A larger aim that several requests serve, with a done check. A schedule that names a goal stops when the goal closes. | `src/requests/tool.ts`, `src/crons/goal-*.ts` |
| **Guard** | The rules that decide whether an agent may run a command or touch a file. The same input always gives the same verdict. | `src/guard/` |
| **Home** | The issue or merge request a piece of work is about. Two runs of one agent on the same home are kept from overwriting each other. | `src/a2a/home.ts` |
| **Intent ledger** | The record of each incoming message, which agent got it and why, and how it ended. See **Ledger** above. | `src/intent/` |
| **Job state** | What a run of agent work says when it ends: done, continue (with a time), waiting (on whom) or blocked. | `src/agents/run-state.ts` |
| **Job** | Agent work that can take several runs: a hand-off, a schedule, a reminder. Each run ends with a job state; the daemon wakes the job again, as a new run, at the time its last run gave. | `src/jobs/` |
| **Mesh peer** | Another machine running AgentX that this one hands work to. See **Mesh** above. | `src/a2a/` |
| **Number** | A tracked figure, read on a rhythm, that shows whether a job is still useful. | `src/numbers/` |
| **Owner** | The person AgentX works for. Their words outrank an agent's. | — |
| **Owner-words check** | When an agent closes the owner's request, the close is compared with what the owner actually asked. | `src/requests/owner-check.ts` |
| **Plan step** | One step of a tracked plan: an owner agent and a "done when" check. The daemon hands each step on in order and nudges one that goes quiet. | `src/requests/plan-store.ts` |
| **Promise** | Something an agent or the owner owes: who owes it, to whom, when, and what closes it. | `src/requests/promise.ts` |
| **Request** | One thing the owner asked for. It stays open on their list until it is done, declined or dropped. One or more jobs (and their runs) do its work. | `src/requests/` |
| **Router** | The one path every incoming message takes: it picks the agent, records the choice and sends the reply back. | `src/channels/router.ts` |
| **Rules Registry** | One wiki page listing the team's rules and where each applies. The rules that apply are added to each run's instructions. | `src/agents/rules-registry.ts` |
| **Session** | One conversation of one agent in one chat, kept so the next message continues it. It holds every turn of that agent in that chat, so a later run remembers the earlier ones. | `src/agents/sessions.ts` |
| **Situation** | The state of one chat (talking, ending, ended), used to decide whether a message needs an answer at all. | `src/situations/` |
| **Standing order** | An "every day" or "every week" order from the owner. It becomes a recurring job with a number, and is never closed as done. | `src/requests/standing.ts` |
| **Turn** | One message in and the agent's answer, as the conversation sees it. Each run is one turn of a session. An engine's own "turns" count (for example Claude Code's) is different: the model steps inside one run. | `src/agents/runtime.ts` |
| **Tool** (AgentX tool) | A function an agent can call during its run, such as `agentx_request` or `agentx_send`. They reach the agent over MCP. | `src/mcp/` |
| **Wake** | Starting a turn for an agent without a new message: at a job's wake time, or when an event it subscribed to happens. | `src/jobs/wake.ts`, `src/events/wake.ts` |
| **Wiki** | The team's shared long-term memory: pages on people, systems, decisions and events, with links between them. | `src/wiki/` |
| **Workflow run** | One execution of a workflow, with each step's state. Some work must run inside a workflow run (`workflows.required`). | `src/workflows/` |

## Request, job, session, run and turn

These five words name the same work at different sizes, from the largest to the smallest:

1. **Request**: what the owner asked for, such as "fix the login page". It stays on their list until it is closed.
2. **Job**: the agent work that does it. A request can have one job or several (one per agent, or one per plan step). A job can need several runs, and the daemon wakes it until its last run says *done*.
3. **Run**: one time an agent works on the job: it starts, works and answers. Its steps, cost and result are recorded.
4. **Turn**: the same run, seen from the chat: one message in, one answer out.
5. **Session**: the conversation the turns belong to: one agent in one chat. It is kept across runs, so each new turn continues where the last one stopped.

Example: the owner asks for a fix (one **request**). The agent gets one **job** for it. Its first **run** makes a pull request and ends with *waiting*. The next morning the daemon wakes the job again, and a second run checks the review. Both runs are **turns** in the same **session**, so the second one remembers the first.

## Check it worked

1. Every term used on a docs page links here or is explained where it first appears.

## If something is wrong

- **A word on a page isn't explained here or on that page:** [open an issue](https://github.com/anis-marrouchi/agentx/issues) naming the page and the word.
- **A definition here disagrees with a page:** the page about that feature is the one to trust; report the mismatch.
