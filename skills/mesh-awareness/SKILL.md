---
name: mesh-awareness
version: 2.1.0
description: Discover agents across local node and mesh peers at runtime — their roles, handles, and how to communicate with or delegate to them.
tags: [mesh, agents, team, roster, delegation, communication, a2a]
triggers:
  - pattern: "who|agent|team|delegate|ask|tell|send to|mention|mesh|peer|roster|available"
    description: "Agent discovery, delegation, and inter-agent communication"
---

# Mesh Awareness — Agent Discovery & Communication

You are part of a multi-agent mesh managed by AgentX. This skill teaches you how to discover other agents and communicate with them.

## Discovering Agents

**Your context already includes a `[Landscape]` section** injected by the AgentX daemon at runtime. It lists all agents on your local node and connected mesh peers. Always refer to that first — it is the live, authoritative source.

If you need more detail or programmatic access, use these commands:

### Local agents (same node)

```bash
curl -s http://127.0.0.1:18800/agents
```

### Full health check (local + mesh + usage)

```bash
curl -s http://127.0.0.1:18800/health | python3 -m json.tool
```

Returns: node info, all local agents (with active task count), mesh peer health, and remote agent lists.

### Mesh peers and their agents

```bash
curl -s http://127.0.0.1:18800/mesh
```

Returns: each peer's URL, health status, and list of agents with IDs, names, and descriptions.

---

## How to Communicate with Other Agents

### 1. Telegram Delegation (preferred for group chats)

Mention another agent's Telegram handle in your response. The AgentX router automatically activates them.

```
@other_bot — can you check the status of issue #642?
```

**Rules:**
- Only works for agents with a Telegram handle
- The agent must be in the same Telegram group
- Don't mention agents you don't need — mentioning activates them
- Only one delegation per response

### 2. HTTP API (programmatic, local node)

```bash
curl -s -X POST http://127.0.0.1:18800/task \
  -H "Content-Type: application/json" \
  -d '{"agent": "<agent-id>", "message": "Your task description"}'
```

### 3. Mesh Task (cross-node, remote agents)

```bash
curl -s -X POST http://127.0.0.1:18800/mesh/task \
  -H "Content-Type: application/json" \
  -d '{"peer": "<peer-name>", "agent": "<agent-id>", "message": "Your task description"}'
```

### 4. AgentX CLI

```bash
# Local agent
agentx daemon send <agent-id> "message"

# Remote agent via mesh
agentx daemon send <agent-id> "message" --peer <peer-name>
```

---

## Agent Role Conventions

Agents often follow a naming pattern that reveals their role:

| Prefix/Pattern | Role | Example |
|----------------|------|---------|
| `pm-*` | Project Manager — coordinates issues, tracks progress | `pm-myproject` |
| `devops-*` | DevOps — deploys, server management, CI/CD | `devops-myproject` |
| `*-coding` / `*-coder` | Coding agent — writes and modifies code | `myproject-coding` |
| `qa-*` | QA — testing, review, forensics | `qa-myproject` |

These are conventions, not requirements. Check the `[Landscape]` section or `/health` endpoint for the actual agent descriptions.

---

## When to Delegate vs Do It Yourself

- **Delegate** when the task belongs to another agent's domain (e.g., you're a PM and need a deploy — ask devops)
- **Do it yourself** when the task is within your own scope
- **Check landscape** when unsure who should handle something — the descriptions will guide you
