# Glossary

Words used across these docs, in plain terms.

| Term | Meaning |
|---|---|
| **A2A** | Agent-to-agent: one agent handing a task to another, on the same machine or another one. See [A2A](./a2a.md). |
| **Activity** | The recorded history of work and routing decisions. See [Activity](../dashboard/activity.md). |
| **Agent** | An AI worker with a workspace, instructions, and a model. |
| **Channel** | A connection that carries messages in from, and replies out to, a tool such as Telegram or GitLab. See [Channels](./channels.md). |
| **Cron** | The timing format behind a schedule, such as `0 9 * * 1-5` for 9:00 on weekdays. In `agentx.json`, schedules live under `crons`. |
| **Daemon** | The AgentX background service that receives work and runs agents. |
| **Dashboard** | The separate browser server for setup and inspection. |
| **Jev** | An optional decision model that answers typed questions (yes/no, pick one of these) for AgentX. The agent's main model still does the open-ended work. See [Jev and typed decisions](../architecture/jev.md). |
| **MCP** | Model Context Protocol, a standard way for AI tools to call outside tools. `agentx serve --stdio` offers AgentX to editors this way. |
| **Mesh** | Connected machines that can hand work to one another. |
| **Node** | A machine running AgentX. |
| **Peer** | Another node that this node is connected to in the mesh. |
| **Provider** | The company or tool that supplies the model, such as an API key account or a signed-in CLI. |
| **Review** | The check AgentX runs after a task finishes to write down what is left to do. Its results appear in [Monitor](../dashboard/monitor.md). |
| **Run** | One execution of a task or workflow. |
| **Schedule** | A timed trigger for a task. |
| **Seat** | One kind of typed question AgentX can hand to a decision model, such as "which on-screen control matches this description?". |
| **Tier** | An agent's engine: `claude-code`, `codex-cli`, `opencode`, `sdk` (Anthropic API key) or `orchestrator` (any provider). The dashboard calls it **AI engine**. |
| **Workflow** | A saved automation with steps. See [Workflow schema](./workflow-schema.md). |

For commands and accepted configuration, see the [CLI](./cli.md) and [configuration](./config.md) references.

## Check it worked

1. **Browser:** open `/glossary` on your dashboard. It has its own in-app glossary for the words shown on screen.
2. Every term used on a docs page links here or is explained where it first appears.

## If something is wrong

- **A word on a page isn't explained here or on that page:** [open an issue](https://github.com/anis-marrouchi/agentx/issues) naming the page and the word.
- **A definition here disagrees with a page:** the page about that feature is the one to trust; report the mismatch.
