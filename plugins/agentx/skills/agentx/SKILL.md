---
name: agentx
description: Work with the person's AgentX node (the self-hosted harness that runs their team of agents) through the agentx tools — check node health, list agents, read recent chats, events, schedules and the wiki, and, only when the full tool set is on and the person asks, hand a task or a message to one of their agents. Use when the person mentions AgentX, their agents, their node or mesh, a schedule (cron) their agents run, or asks to ask, tell or delegate to a named agent.
---

# Work with an AgentX node

AgentX is a self-hosted harness: a background service (the **node**, or daemon) runs a team of AI agents and connects them to chat channels, schedules and webhooks. This plugin gives you its tools. Every tool name starts with `agentx_`.

## 1. Check the node first

Call `agentx_health` before anything else in a session.

- If it answers, continue.
- If it fails with "fetch failed", the node is not running or listens elsewhere. Tell the person to run `agentx daemon status` in a terminal, or to set the plugin's **Node address** option. Stop there.
- If it fails with "Unauthorized", the node wants a token. Tell the person to set the plugin's **Node token** option. Stop there.

## 2. Look before you act

These tools only read. Use them freely to answer questions:

| Question | Tool |
| --- | --- |
| Which agents are there, and are they busy? | `agentx_agents` |
| What was said on a channel or chat? | `agentx_recent` |
| What happened since a given time? | `agentx_events` |
| What runs on a schedule? | `agentx_crons` |
| What machine is this, is there a usage limit right now, which version of a program is installed? | `agentx_node` (quote its check time) |
| What does the team know about a topic? | `agentx_wiki_query` |
| What is this project's stack? | `agentx_inspect` |

Quote agent ids exactly as `agentx_agents` returns them. Never guess an id.

## 3. Act only when asked

With the default **read** tool set, tools that send, start or change something are refused. That is expected: tell the person which tool would do it and that they can switch the plugin's **Tool set** option to `full`.

With the **full** tool set:

1. Act only on a clear request from the person ("ask the reviewer agent to…", "send this to…"). Never send on your own initiative.
2. Before you send, show the person the target agent id and the exact message, and wait for a yes.
3. Use `agentx_task` (fields `agent`, `message`) to hand an agent a job, or `agentx_send_agent` (fields `agentId`, `text`) for a message to an agent on this node or a connected node.
4. Both calls return a task id at once. Do not send the same message again. Tell the person who you asked; the answer arrives later.
5. Changing schedules (`agentx_schedule`) and answering approvals (`agentx_approval`) need the same explicit yes.

## 4. Keep private things private

Recent chats, events and the wiki can hold other people's messages. Use them to answer the person's question; do not paste long transcripts back or copy them into files, commits or issues.
