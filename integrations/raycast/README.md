# AgentX for Raycast

Talk to your AgentX agents from [Raycast](https://www.raycast.com) without
opening the dashboard.

| Command | What it does |
| --- | --- |
| **Ask Agent** | Pick an agent, type a message, read the reply as markdown. |
| **List Agents** | The agents on this node, whether each is working, and when it was last active. |
| **Open Dashboard** | Opens the dashboard in the browser. |

The extension talks to the local daemon over HTTP, like the built-in TUI:
`GET /agents` for the list and `POST /task` for a message. Ask Agent waits
for the full reply, then shows it. Each agent keeps one Raycast conversation
(`raycast:operator`), so follow-up questions have the earlier context.

## Install from this checkout

The AgentX daemon must be running.

```bash
cd integrations/raycast
npm install
npm run dev
```

`npm run dev` adds the extension to Raycast. It stays there after you stop the
command.

## Preferences

| Preference | Default | When to change it |
| --- | --- | --- |
| Daemon URL | `http://127.0.0.1:18800` | Your `node.bind` in `agentx.json` is different, or the daemon is on another machine. |
| Token | empty | Only for a daemon on another machine: its mesh token. Local calls don't need one. |
| Dashboard URL | `http://127.0.0.1:4202/live` | Your dashboard runs on another port or host. |

## Not yet

- Replies don't stream; long answers show a spinner until they finish.
- Only this node's agents; peers on other machines are not listed.
- Not published to the Raycast Store.
