# Install the AgentX plugin in Claude Code

The **AgentX plugin** is a pack you add to Claude Code with one command. It gives Claude Code:

- **The AgentX tool server.** Claude Code can check your AgentX node (the background program that runs your agents), list your agents, and read recent chats, events, schedules and the wiki. If you allow it, it can also hand tasks to your agents.
- **Two skills.** A skill is a short instruction file that Claude Code reads when a request matches it. `agentx` teaches Claude Code to use the tools safely: it checks the node first and asks you before it sends anything. `agentx-contribute` helps you file a clear AgentX issue.

The plugin adds about 220 tokens (the units a model reads text in) to each session, for the two skill descriptions. A skill's full text loads only when it is used.

![How the AgentX plugin reaches Claude Code: you run one install command, choose the read or full tool set and start a new session; Claude Code then loads the two skills and the agentx tool server, a skill picks the tool, and your AgentX node answers](/diagrams/plugin-install.svg)

For Cursor, VS Code or Windsurf, follow [Use AgentX from your code editor](./connect-an-editor.md) instead. Those editors take the same tool server but no plugin.

## Before you start

1. **Terminal:** run `agentx --version` to check that AgentX is installed. The plugin starts the `agentx` command, so it must be on your `PATH`.
2. **Terminal:** run `agentx daemon status` to check that your AgentX node is up.
3. **Terminal:** run `claude --version`. The one-command install needs Claude Code 2.1.275 or later. An older version works with the two commands under [Older Claude Code](#older-claude-code).

## Install it

1. **Terminal:** run:

   ```bash
   claude plugin install agentx --marketplace anis-marrouchi/agentx
   ```

   This adds the AgentX **marketplace** (the list of plugins this repository offers) and installs the `agentx` plugin from it, for your user.

2. **Terminal:** start a new Claude Code session, or type `/reload-plugins` in an open one.

You can also install from inside Claude Code: type `/plugin install agentx --marketplace anis-marrouchi/agentx`.

### Older Claude Code

1. **Terminal:** run `claude plugin marketplace add anis-marrouchi/agentx`.
2. **Terminal:** run `claude plugin install agentx@agentx`.
3. **Terminal:** start a new Claude Code session.

## Choose its settings

The plugin works without settings for a node on the same machine. It starts in the **read** tool set: it looks, and sends, starts and changes nothing.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Tool set | `tools` | `read` | `read` only looks. `full` also sends messages, starts tasks, changes schedules and answers approvals. |
| Node address | `daemon_url` | empty | Your node's address, for example `http://node.example.com:18800`. Empty uses `node.bind` from `agentx.json` in the AgentX folder, else `http://localhost:18800`. |
| Node token | `token` | empty | The node's `MESH_TOKEN`, needed only for a node on another machine. Claude Code keeps it in your system's secure store. |
| AgentX folder | `install_dir` | `.` | The folder that holds `agentx.json`, as a full path. `.` is the folder Claude Code was started in. |

To change them:

1. **Claude Code:** type `/plugin configure agentx@agentx`.
2. Fill in the settings you need and save.
3. Start a new Claude Code session.

To set them while installing, add one `--config` per setting, for example:

```bash
claude plugin install agentx --marketplace anis-marrouchi/agentx --config tools=full --config install_dir=/home/you/agentx
```

## Check it worked

1. **Terminal:** run `claude plugin list`. `agentx@agentx` shows as enabled.
2. **Terminal:** run `claude mcp list`. The line `plugin:agentx:agentx` ends in `Connected`.
3. **Claude Code:** ask "Check my AgentX node." Claude Code calls `agentx_health` and shows your node's health report.
4. **Claude Code:** with the default `read` tool set, ask it to send a task to an agent. It explains that the tool set is `read` and sends nothing.

## Update or remove it

- **Update. Terminal:** run `claude plugin marketplace update agentx`, then `claude plugin update agentx@agentx`.
- **Remove. Terminal:** run `claude plugin uninstall agentx@agentx`. To remove the marketplace too, run `claude plugin marketplace remove agentx`.

## If something is wrong

- **`plugin:agentx:agentx` shows "Failed to connect".** Claude Code cannot start `agentx`. Run `agentx --version` in the same terminal. If it is not found, install AgentX ([Install](../install.md)) or add its folder to your `PATH`, then start a new session.
- **"fetch failed".** The node is not running, or it listens somewhere else. Run `agentx daemon status`, or set **Node address**.
- **"Unauthorized".** The node wants a token. Set **Node token** to the node's `MESH_TOKEN`.
- **"… is not in the "read" tool set".** That tool acts on your agents. Set **Tool set** to `full` if you want to allow it, then start a new session.
- **"unknown option '--marketplace'".** Your Claude Code is older than 2.1.275. Use the two commands under [Older Claude Code](#older-claude-code), or update Claude Code.
