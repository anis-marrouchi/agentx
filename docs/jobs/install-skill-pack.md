# Install the AgentX skill pack in Claude Code

Claude Code is a coding assistant that runs in a terminal. You can teach it about AgentX with one install. A **plugin** is a bundle that Claude Code installs in one go. The AgentX plugin holds:

- **Three skills.** A **skill** is a short instruction file that tells the assistant how to do one job. The pack has `agentx-node` (look at your node, agents and schedules), `agentx-contribute` (help you file a clear AgentX issue) and `daemon-ops` (restart, logs and status of the AgentX background program on this machine).
- **The agentx tool server.** This is the program from [Use AgentX from your code editor](/jobs/connect-an-editor), already set up. It starts with the `read` tool set: the assistant can look, but it sends nothing, starts nothing and changes nothing.

Here is the whole path:

![How the AgentX skill pack reaches Claude Code: you run one command, choose the read or full tool set and start a new session; Claude Code then loads the three skills and the agentx tool server, a skill picks the tool, and your AgentX node answers](/diagrams/skill-pack.svg)

The pack adds about 350 tokens to every Claude Code session: that is the one-line description of each skill. A skill's full text loads only when it is used.

## Before you start

1. **Terminal:** run `claude --version` to check that Claude Code is installed. You need version 2.1.275 or newer for the one-line install below.
2. **Terminal:** run `agentx --version` to check that AgentX is installed. The tool server runs the `agentx` command, so it must work in a new terminal.
3. **Terminal:** run `agentx daemon status` to check that your AgentX node (the background program that runs your agents) is up.

## Install it

1. **Terminal:** run this command:

   ```bash
   claude plugin install agentx --marketplace anis-marrouchi/agentx
   ```

   A **marketplace** is a list of plugins that Claude Code can install from. This command adds the AgentX marketplace from GitHub and installs the `agentx` plugin from it. It prints:

   ```text
   √ Successfully added marketplace: agentx (declared in user settings)
   √ Successfully installed plugin: agentx@agentx (scope: user)
   ```

   On an older Claude Code, run the two steps on their own instead:

   ```bash
   claude plugin marketplace add anis-marrouchi/agentx
   claude plugin install agentx@agentx
   ```

2. **Terminal:** start a new Claude Code session with `claude`. Claude Code reads plugins when a session starts.

You can also do both steps from inside Claude Code: type `/plugin install agentx --marketplace anis-marrouchi/agentx`, then start a new session.

## Choose the options

The plugin has three options. All of them can stay empty for a node on the same machine.

| Option | What it does | Default |
|---|---|---|
| `tools` | The tool set. `read` looks only. `full` also sends messages, starts tasks, changes schedules, answers approvals and edits the wiki. | `read` |
| `daemon_url` | The address of your AgentX node, for a node on another machine. | Empty: `http://localhost:18800` |
| `token` | The node's `MESH_TOKEN`, for a node on another machine. Claude Code stores it as a secret. | Empty |

To set an option:

1. **Terminal:** run this command, with the values you want:

   ```bash
   claude plugin install agentx --marketplace anis-marrouchi/agentx --config tools=full
   ```

   Add one `--config name=value` for each option, for example `--config daemon_url=http://node.example.com:18800 --config token=<your-token>`.

2. **Terminal:** start a new Claude Code session.

Or, inside Claude Code, type `/plugin configure agentx@agentx` and answer the questions, then start a new session.

## Check it worked

1. **Terminal:** run `claude plugin list`. Check that `agentx@agentx` shows `Status: √ enabled`.
2. **Terminal:** run `claude plugin details agentx@agentx`. Check that it lists 3 skills and 1 MCP server.
3. In Claude Code, type `/mcp`. Check that `plugin:agentx:agentx` shows as connected.
4. Ask Claude Code: "Is my AgentX node healthy?"
5. The answer is your node's health report, taken from `agentx_health`. An error instead means the tool server runs but cannot reach the node: see below.

## Update or remove it

1. **Terminal:** run `claude plugin marketplace update agentx` to fetch the newest pack, then `claude plugin update agentx@agentx`.
2. **Terminal:** run `claude plugin uninstall agentx@agentx` to remove the plugin. Run `claude plugin marketplace remove agentx` to remove the marketplace too.

## If something is wrong

- **"marketplace not found" or a GitHub error during install.** Claude Code could not download the pack. Check your internet connection and try again.
- **`agentx@agentx` is not listed, or the skills do not show.** Start a new Claude Code session; a running session does not see a new plugin.
- **`plugin:agentx:agentx` shows as failed.** Claude Code could not start `agentx`. In a new terminal, run `agentx --version`. If that fails, install AgentX or fix your `PATH`, then start a new session.
- **"fetch failed".** The node is not running, or it listens elsewhere. Run `agentx daemon status` in a terminal, or set the `daemon_url` option.
- **"Unauthorized".** The node wants a token. Set the `token` option to the node's `MESH_TOKEN`.
- **"… is not in the "read" tool set".** That tool acts on your agents. Set the `tools` option to `full` if you want to allow it, then start a new session.
