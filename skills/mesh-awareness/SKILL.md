---
name: mesh-awareness
version: 3.0.0
description: Discover agents across local node and mesh peers at runtime — their roles, handles, and how to communicate with or delegate to them.
tags: [mesh, agents, team, roster, delegation, communication, a2a]
triggers:
  - pattern: "who|agent|team|delegate|ask|tell|send to|mention|mesh|peer|roster|available"
    description: "Agent discovery, delegation, and inter-agent communication"
---

# Mesh Awareness — Agent Discovery & Communication

You are part of a multi-agent mesh managed by AgentX. This skill teaches you how to discover other agents and communicate with them.

## Your Node: `clawd-server`

- **API port:** `19900`
- **Default agent:** `atlas`
- **Mesh peer:** `macbook-local` at `http://100.82.31.24:18800`

---

## Agent Roster — `clawd-server`

### Core / Platform

| Agent ID | Name | Telegram Handle | GitLab Handle | Role |
|----------|------|-----------------|---------------|------|
| `atlas` | Main Agent | `@noqta_atlas_bot` | `@atlas` / `@noqta-atlas` | Default agent, general coordinator |
| `product-director` | Product Director | `@noqta_director_bot` | — | Oversees all PMs and product strategy |
| `seif` | Seif Agent | — | — | Personal assistant (reports to atlas) |
| `omar` | Omar Agent | — | — | Personal assistant (reports to atlas) |
| `razi-biodata` | Razi (Bio-Data Architect) | `@noqta_razi_bot` | — | Bio-data specialist (reports to atlas) |
| `noqta-public` | Noqta Public Agent | `@noqta_public_bot` | — | Public-facing agent |

### MTGL Project Team

| Agent ID | Telegram Handle | GitLab Handle | Role |
|----------|-----------------|---------------|------|
| `pm-mtgl` | `@noqta_pm_mtgl_bot` | `@pm-mtgl` / `@noqta-pm-mtgl` | PM — coordinates MTGL tasks |
| `mtgl-v2` | `mtgl-coder` / `coding-mtgl-v2` | `@mtgl-v2-coder` / `@mtgl-coder` / `@coding-mtgl-v2` | Coder — Laravel/React (Opus model) |
| `mtgl-v1` | — | — | MTGL V1 legacy agent |
| `mtgl-v1-2` | — | — | MTGL V1 Coder #2 |
| `mtgl-website` | — | — | MTGL website agent |
| `devops-mtgl` | — | `@devops-mtgl` | DevOps — deploy, infra |
| `qa-forensics` | — | `@qa-forensics` | QA — review, regressions, safety |

### KSI Project Team

| Agent ID | Telegram Handle | GitLab Handle | Role |
|----------|-----------------|---------------|------|
| `pm-ksi` | `@noqta_pm_ksi_bot` | — | PM — coordinates KSI tasks |
| `ksi-v2` | `@noqta_ksi_bot` | — | Coder |
| `devops-ksi` | — | — | DevOps |

### Hackathonat Project Team

| Agent ID | Telegram Handle | GitLab Handle | Role |
|----------|-----------------|---------------|------|
| `pm-hackathonat` | `@noqta_pm_hack_bot` | — | PM |
| `hackathonat` | `@noqta_hackathonat_bot` | — | Coder |
| `devops-hackathonat` | — | — | DevOps |

### Hasanah Project Team

| Agent ID | Telegram Handle | GitLab Handle | Role |
|----------|-----------------|---------------|------|
| `pm-hasanah` | `@noqta_pm_hasanah_bot` | — | PM |
| `hasanah-coding` | `@noqta_hasanah_bot` | — | Coder |
| `devops-hasanah` | — | — | DevOps |

---

## Agent Roster — `macbook-local` (mesh peer)

| Agent ID | Name | Telegram Handle | GitLab Handle | Role |
|----------|------|-----------------|---------------|------|
| `atlas` | Main Agent | `@noqta_atlas_bot` | `@atlas` / `@noqta-atlas` | Coordinator, catch-all, technical advisor |
| `devops-agent` | DevOps | `@noqta_devops_bot` | `@devops-noqta` | SysAdmin, infrastructure, deployments, CI/CD |
| `marketing-agent` | Nadia | `@noqta_nadia_bot` | — | Marketing, content creation, SEO, social media |

---

## Reporting Hierarchy

```
product-director
├── pm-mtgl → mtgl-v2, mtgl-v1, mtgl-v1-2, mtgl-website, devops-mtgl, qa-forensics
├── pm-ksi → ksi-v2, devops-ksi
├── pm-hackathonat → hackathonat, devops-hackathonat
└── pm-hasanah → hasanah-coding, devops-hasanah

atlas
├── seif
├── omar
├── razi-biodata
└── noqta-public
```

---

## Discovering Agents at Runtime

**Your context already includes a `[Landscape]` section** injected by the AgentX daemon at runtime. It lists all agents on your local node and connected mesh peers. Always refer to that first — it is the live, authoritative source.

If you need more detail or programmatic access, use these commands:

### Local agents (same node)

```bash
curl -s http://127.0.0.1:19900/agents
```

### Full health check (local + mesh + usage)

```bash
curl -s http://127.0.0.1:19900/health | python3 -m json.tool
```

Returns: node info, all local agents (with active task count), mesh peer health, and remote agent lists.

### Mesh peers and their agents

```bash
curl -s http://127.0.0.1:19900/mesh
```

Returns: each peer's URL, health status, and list of agents with IDs, names, and descriptions.

---

## How to Communicate with Other Agents

### 1. Telegram Delegation (preferred for group chats)

Mention another agent's Telegram handle in your response. The AgentX router automatically activates them.

```
@noqta_pm_mtgl_bot — can you check the status of issue #642?
```

**Rules:**
- Only works for agents with a Telegram handle
- The agent must be in the same Telegram group
- Don't mention agents you don't need — mentioning activates them
- Only one delegation per response

### 2. HTTP API (programmatic, local node)

```bash
curl -s -X POST http://127.0.0.1:19900/task \
  -H "Content-Type: application/json" \
  -d '{"agent": "<agent-id>", "message": "Your task description"}'
```

### 3. Mesh Task (cross-node, remote agents)

**Use `async: true`. Always. A synchronous mesh delegation will be killed
before the remote agent finishes, and its answer will be lost.**

```bash
curl -s -X POST http://127.0.0.1:19900/mesh/task \
  -H "Content-Type: application/json" \
  -d '{
    "peer": "<peer-name>",
    "agent": "<agent-id>",
    "message": "Your task description",
    "async": true,
    "senderAgentId": "<your own agent id>",
    "context": {"channel": "<the channel you were asked on>",
                "chatId": "<the chat id you were asked in>"}
  }'
```

This returns `202 {accepted, taskId, deliverTo}` immediately. The daemon
holds the long call in the background and **delivers the remote agent's
answer straight to that chat** when it lands. You do not wait, and you do
not relay it yourself.

#### Why `async` and not a longer timeout

A delegated agent run takes minutes. An agent's Bash tool kills any
command at **2 minutes**, and `curl -m 600` does NOT change that — the
tool's own timeout fires regardless of curl's. This has already lost real
work: a remote agent completed a full report 47 seconds after the call was
killed, and the user never saw it.

Raising the Bash timeout is not the fix either. It makes the delegation
only as reliable as the longest thing you can keep a socket open for.
`async` removes the wait entirely.

#### `context` is the route home — it is not optional

`context.channel` and `context.chatId` are how the daemon knows where to
deliver the result. Without them:

- the request is **rejected** with 400 in async mode, and
- in sync mode the task lands on the remote node as `api:default`,
  detached from the conversation that asked for it.

Pass the channel and chat id you were actually asked on.

#### Never promise to poll

**You cannot poll.** An agent turn is a single execution — when you reply,
you stop existing. Nothing wakes you when the remote agent finishes.
Saying "I'm polling for his report and will send it when it lands" is
stating something impossible, and it has been said to a user who then
received nothing.

With `async: true` the daemon delivers the answer. Say that instead:
"Delegated to <agent> on <peer>. His answer will arrive here when he's
done." Then stop.

### 4. AgentX CLI

```bash
# Local agent
agentx daemon send <agent-id> "message"

# Remote agent via mesh
agentx daemon send <agent-id> "message" --peer macbook-local
```

---

## Channels

| Channel | Details |
|---------|---------|
| **Telegram** | Multiple bots, one per agent. Group policy: mention-required. DM policy: pair. |
| **WhatsApp** | Atlas handles messages from `+21624309128` |
| **GitLab** | `gitlab.noqta.tn` — webhooks route by project to the relevant PM agent |

**GitLab project → agent routing:**
- `mtgl/mtgl-system-v2` → `pm-mtgl`
- `mtgl/mtgl-website` → `mtgl-website`
- `noqta/ksi-v2` or `ksi/ksi-v2` → `pm-ksi`
- `noqta/hackathonat` → `pm-hackathonat`
- `*` (catch-all) → `atlas`

---

## When to Delegate vs Do It Yourself

- **Delegate** when the task belongs to another agent's domain (e.g., you're a PM and need a deploy — ask devops)
- **Do it yourself** when the task is within your own scope
- **Check landscape** when unsure who should handle something — the descriptions will guide you
