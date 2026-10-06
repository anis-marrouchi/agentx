# Glossary

Words used across these docs, in plain terms.

| Term | Meaning |
|---|---|
| **A2A** | Agent-to-agent: one agent handing a task to another, on the same machine or another one. It is also the name of an open standard for agents talking to each other. See [A2A](./a2a.md). |
| **Activity** | The recorded history of work and routing decisions. See [Activity](../dashboard/activity.md). |
| **Agent** | An AI assistant that does work for you. It has a workspace, written instructions, and a model. Some pages say *AI helper*, *AI worker* or *AI teammate*: they all mean an agent. |
| **AgentX Helper** | A separate small Mac app that shows AgentX notification banners with the AgentX logo. It is not the voice assistant. See [Get notified](../jobs/notifications.md). |
| **AgentX Voice** | The voice assistant for your Mac: hold a key, speak, and an agent answers out loud. macOS lists the app as **AgentX Desktop**, some pages call it the *desktop assistant*, and you install it with `agentx desktop install`. All three mean AgentX Voice. See [AgentX Voice](../guides/agentx-voice.md). |
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
| **Routine** | Another word for a schedule. The dashboard's **Operations** tab lists schedules, and workflows that start by themselves, under **Routines**. See **Schedule**. |
| **Run** | One execution of a task or workflow. |
| **Schedule** | Work that starts at set times by itself, such as a summary every Friday. Also called a *scheduled job*, *cron job* or *routine*. `agentx schedule` and `agentx cron` manage them. |
| **Seat** | One named kind of small question AgentX can hand to a decision model (Jev), such as "which on-screen control matches this description?". Each seat can be off, watching only, or active. |
| **Tier** | An agent's engine: `claude-code`, `codex-cli`, `opencode`, `sdk` (Anthropic API key) or `orchestrator` (any provider). The dashboard calls it **AI engine**. |
| **Token** | A secret code that proves a program or machine may use something, like a password for programs. AgentX uses several: the *mesh token* that lets your machines trust each other, the dashboard token (`dashboard.token`), scoped tokens from `agentx token`, and the tokens channels such as Telegram give you. Never share or paste one in public. |
| **wacli** | A separate WhatsApp command-line tool. AgentX uses it to read watched WhatsApp chats and send the replies you approve. See [Watch a WhatsApp chat](../jobs/watch-whatsapp.md). |
| **Workflow** | A saved automation with steps. See [Workflow schema](./workflow-schema.md). |
| **Workspace** | An agent's own folder on the computer. It holds the agent's instructions and the files it works on. Set it with `workspace` in the agent's settings. |

For commands and accepted configuration, see the [CLI](./cli.md) and [configuration](./config.md) references.

## Check it worked

1. **Browser:** open `/glossary` on your dashboard. It has its own in-app glossary for the words shown on screen.
2. Every term used on a docs page links here or is explained where it first appears.

## If something is wrong

- **A word on a page isn't explained here or on that page:** [open an issue](https://github.com/anis-marrouchi/agentx/issues) naming the page and the word.
- **A definition here disagrees with a page:** the page about that feature is the one to trust; report the mismatch.
