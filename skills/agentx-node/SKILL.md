---
name: agentx-node
version: 1.0.0
description: Look at an AgentX node from a coding assistant through the agentx tools — node health, the agents and what they are doing, schedules and their failures, recent chats, events and the wiki. Use when someone asks about their AgentX agents, schedules, recent messages, or whether their node is healthy.
tags: [agentx, mcp, health, agents, crons]
triggers:
  - pattern: "agentx|my agents|agent (status|health)|node health|cron.*(fail|health)|schedules?.*(fail|status)"
    description: "Questions about an AgentX node and its agents"
---

# Look at an AgentX node

AgentX runs a team of agents on the person's own machines. You reach it through the `agentx` tool server (`agentx serve --stdio`). By default this pack starts it with the `read` tool set: you can look, but you send nothing, start nothing and change nothing.

## Pick the tool

| The person asks | Call |
|---|---|
| "Is my node OK?" | `agentx_health` |
| "Which agents do I have? What are they doing?" | `agentx_agents` (add `landscape: true` for handles, roles and mesh peers) |
| "Are my schedules running? Which one fails?" | `agentx_crons` |
| "What was said in that chat?" | `agentx_recent` with `channel` and `chatId` |
| "What happened while I was away?" | `agentx_events`; pass the returned `next` as `since` next time |
| "What did we decide about …? Who is …?" | `agentx_wiki_query` with the question |

## Rules

1. Call a tool before you answer. Do not guess what an agent did or said.
2. Report what the tool returned, in short plain sentences. Quote ids, times and error counts exactly.
3. Keep private content private. Chats and wiki pages can hold personal data; show only what the question needs.
4. If a tool answers "is not in the "read" tool set", tell the person that this tool acts on their agents and that they can allow it by switching the server to `--tools full`. Do not look for another way to do the action.
5. If a tool answers "fetch failed", the node is not running or listens elsewhere. Suggest `agentx daemon status` in a terminal, or setting `AGENTX_DAEMON_URL`.
6. If a tool answers "Unauthorized", the node wants a token. Suggest setting `AGENTX_TOKEN`.
