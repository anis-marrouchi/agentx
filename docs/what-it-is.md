# What AgentX is

AgentX is an operations layer for AI agents. An **agent** has a workspace, instructions, and a model. A **channel** brings in a message from a tool your team uses. AgentX routes the message, starts the right agent, and records the result. A **schedule** can start work without a message.

You host AgentX yourself. The daemon handles messages and scheduled work. A separate dashboard process serves the browser setup and daily views. The browser can be open while the daemon is stopped, so check both when work is not arriving.

You can begin with one agent on one machine. If work belongs on another machine, AgentX can connect nodes into a mesh. You do not need a mesh to use the first agent.

[See it in a demo](./see-it-first.md) or [install it](./install.md).
