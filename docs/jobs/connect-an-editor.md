# Use AgentX from your code editor

Code editors with a built-in assistant (Claude Code, Cursor, VS Code and Windsurf) can use extra tools that another program offers. The way they talk to that program is called **MCP**, the Model Context Protocol, and the program is called an **MCP server** or a **tool server**.

AgentX ships one: `agentx serve --stdio`. Once your editor knows about it, its assistant can check your agents, read recent chats, look at schedules, and, if you allow it, send messages and hand tasks to your agents. Here is the whole path:

![How a code editor uses AgentX's tools: you add agentx serve --stdio to the editor's tool servers, choose a tool set and restart the editor; the editor then starts the tool server, the assistant calls a tool, and the tool server asks your AgentX node with its token](/diagrams/editor-connect.svg)

## Choose a tool set

A **tool set** decides which tools the editor gets. You pick it with `--tools`:

| Tool set | What the assistant can do |
|---|---|
| `full` (the default) | Everything: read, and also send messages, start tasks, change schedules, answer approvals and edit the wiki. |
| `read` | Look only: agents, health, recent chats, events, schedules, the voice queue, the wiki and project details. It sends nothing, starts nothing and changes nothing. |

Start with `read` if you only want the assistant to see what your agents are doing. With `read`, a tool outside the set is refused even when the assistant asks for it by name.

## Before you start

1. **Terminal:** run `agentx --version` to check that AgentX is installed.
2. **Terminal:** run `agentx daemon status` to check that your AgentX node (the background program that runs your agents) is up.
3. Note the folder AgentX is installed in, the one that holds `agentx.json`. The examples below use `~/agentx`; use your own.

The tool server finds your node and its token by itself:

- **Address.** It reads `node.bind` from `agentx.json`. Without one, it uses `http://localhost:18800`. Set `AGENTX_DAEMON_URL` to reach a node on another machine.
- **Token.** Every call to the node carries `Authorization: Bearer <token>`. The token comes from `AGENTX_TOKEN` if you set it, then `MESH_TOKEN` (from the environment or the install's `.env` file), then `dashboard.token` in `agentx.json`. A node on the same machine accepts calls without a token; a node on another machine needs one.

## Add it to Claude Code

1. **Terminal:** run this command, with your own install folder:

   ```bash
   claude mcp add agentx -- agentx serve --stdio --tools read --cwd ~/agentx
   ```

2. **Terminal:** to reach a node on another machine, add its address and token instead:

   ```bash
   claude mcp add agentx -e AGENTX_DAEMON_URL=http://node.example.com:18800 -e AGENTX_TOKEN=<your-token> -- agentx serve --stdio --tools read
   ```

3. **Terminal:** start a new Claude Code session.

## Add it to Cursor

1. Open `~/.cursor/mcp.json` in a text editor (create it if it does not exist).
2. Paste this, with your own install folder:

   ```json
   {
     "mcpServers": {
       "agentx": {
         "command": "agentx",
         "args": ["serve", "--stdio", "--tools", "read", "--cwd", "~/agentx"]
       }
     }
   }
   ```

3. Save the file.
4. Restart Cursor.

## Add it to VS Code

1. Open `.vscode/mcp.json` in your project (create it if it does not exist).
2. Paste this, with your own install folder:

   ```json
   {
     "servers": {
       "agentx": {
         "type": "stdio",
         "command": "agentx",
         "args": ["serve", "--stdio", "--tools", "read", "--cwd", "~/agentx"]
       }
     }
   }
   ```

3. Save the file.
4. Restart VS Code.

## Add it to Windsurf

1. Open `~/.codeium/windsurf/mcp_config.json` in a text editor (create it if it does not exist).
2. Paste the same block as for Cursor (the one that starts with `"mcpServers"`).
3. Save the file.
4. Restart Windsurf.

To reach a node on another machine from Cursor, VS Code or Windsurf, add an `env` entry next to `args`:

```json
"env": { "AGENTX_DAEMON_URL": "http://node.example.com:18800", "AGENTX_TOKEN": "<your-token>" }
```

To give the assistant every tool, replace `"read"` with `"full"`, or leave out `--tools` and its value.

## Check it worked

1. Open your editor's list of tool servers (in Claude Code, type `/mcp`).
2. Check that `agentx` shows as connected.
3. Ask the assistant: "Use agentx_health to check my AgentX node."
4. The answer is your node's health report. An error instead means the tool server is running but cannot reach the node: see below.

## If something is wrong

- **`agentx` is not in the list.** Check the file for a missing comma or bracket, save it, and restart the editor.
- **"fetch failed".** The node is not running, or it listens elsewhere. Run `agentx daemon status` in a terminal, or set `AGENTX_DAEMON_URL` to the node's address.
- **"Unauthorized".** The node wants a token. Set `AGENTX_TOKEN` to the node's `MESH_TOKEN`.
- **"… is not in the "read" tool set".** That tool acts on your agents. Change `--tools read` to `--tools full` if you want to allow it, then restart the editor.
- **The editor runs an older AgentX.** Run `agentx --version` in a terminal and update if needed; `--tools` arrived with this page.
