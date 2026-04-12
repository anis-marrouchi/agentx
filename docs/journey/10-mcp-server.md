---
title: "10. MCP server — drive AgentX from Claude Code or Cursor"
---

# 10. MCP server — drive AgentX from Claude Code or Cursor

> **Status:** planned (V2) · **Difficulty:** advanced

::: warning This page is on the roadmap
Full walkthrough is coming. The MCP server is shipped — outline below.
:::

## Scenario (planned)

You're coding in Cursor or Claude Code. You type `@agentx send the deploy summary to the team Telegram` — Cursor calls AgentX's MCP tools to dispatch the message. Or you ask `@agentx what are Nadia's crons today?` — the same MCP surface answers from the daemon's live state. Any MCP-capable client becomes a remote control for your AgentX fleet.

## Outline (what this page will teach)

- Adding AgentX to your Cursor / Claude Code MCP config
- Tool surface exposed today:
  - `agentx_send` — cross-channel outbound
  - `agentx_task` — delegate a task to an agent
  - `agentx_generate` — tech-stack-aware code generation
  - `agentx_agents`, `agentx_health`, `agentx_crons`, `agentx_debug` — introspection
- Elicitation (form-based user input inside MCP)
- Authenticating the MCP client to the daemon

## Today's nearest equivalents

- **Source** — tool implementations live at [`src/mcp/`](https://github.com/anis-marrouchi/agentx/tree/master/src/mcp)
- **Alternative** — the same actions over raw HTTP: [communication-matrix → `/task` / `/send`](/reference/communication-matrix)

## Why expose AgentX as MCP

MCP is the common language of the modern IDE agent stack. Exposing AgentX as an MCP server lets your Cursor session trigger production-grade channels (Telegram, GitLab, crons, mesh) without shelling out to `curl`.
