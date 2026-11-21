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

## Your Node: `peer-server`

- **API port:** `19900`
- **Default agent:** `atlas`
- **Mesh peer:** `hq-local` at `http://100.64.0.12:18800`

---

## Agent Roster — `peer-server`

### Core / Platform

| Agent ID | Name | Telegram Handle | GitLab Handle | Role |
|----------|------|-----------------|---------------|------|
| `atlas` | Main Agent | `@acme_atlas_bot` | `@atlas` / `@acme-atlas` | Default agent, general coordinator |
| `product-director` | Product Director | `@acme_director_bot` | — | Oversees all PMs and product strategy |
| `sam` | Sam Agent | — | — | Personal assistant (reports to atlas) |
| `jordan` | Jordan Agent | — | — | Personal assistant (reports to atlas) |
| `rae-biodata` | Rae (Bio-Data Architect) | `@acme_rae_bot` | — | Bio-data specialist (reports to atlas) |
| `acme-public` | Acme Public Agent | `@acme_public_bot` | — | Public-facing agent |

### Globex Project Team

| Agent ID | Telegram Handle | GitLab Handle | Role |
|----------|-----------------|---------------|------|
| `pm-globex` | `@acme_pm_globex_bot` | `@pm-globex` / `@acme-pm-globex` | PM — coordinates Globex tasks |
| `globex-v2` | `globex-coder` / `coding-globex-v2` | `@globex-v2-coder` / `@globex-coder` / `@coding-globex-v2` | Coder — Laravel/React (Opus model) |
| `globex-v1` | — | — | Globex V1 legacy agent |
| `globex-v1-2` | — | — | Globex V1 Coder #2 |
| `globex-website` | — | — | Globex website agent |
| `devops-globex` | — | `@devops-globex` | DevOps — deploy, infra |
| `qa-forensics` | — | `@qa-forensics` | QA — review, regressions, safety |

### Initech Project Team

| Agent ID | Telegram Handle | GitLab Handle | Role |
|----------|-----------------|---------------|------|
| `pm-initech` | `@acme_pm_initech_bot` | — | PM — coordinates Initech tasks |
| `initech-v2` | `@acme_initech_bot` | — | Coder |
| `devops-initech` | — | — | DevOps |

### DemoSite Project Team

| Agent ID | Telegram Handle | GitLab Handle | Role |
|----------|-----------------|---------------|------|
| `pm-demosite` | `@acme_pm_hack_bot` | — | PM |
| `demosite` | `@acme_demosite_bot` | — | Coder |
| `devops-demosite` | — | — | DevOps |

### Umbrella Project Team

| Agent ID | Telegram Handle | GitLab Handle | Role |
|----------|-----------------|---------------|------|
| `pm-umbrella` | `@acme_pm_umbrella_bot` | — | PM |
| `umbrella-coding` | `@acme_umbrella_bot` | — | Coder |
| `devops-umbrella` | — | — | DevOps |

---

## Agent Roster — `hq-local` (mesh peer)

| Agent ID | Name | Telegram Handle | GitLab Handle | Role |
|----------|------|-----------------|---------------|------|
| `atlas` | Main Agent | `@acme_atlas_bot` | `@atlas` / `@acme-atlas` | Coordinator, catch-all, technical advisor |
| `devops-agent` | DevOps | `@acme_devops_bot` | `@devops-acme` | SysAdmin, infrastructure, deployments, CI/CD |
| `marketing-agent` | Marketing | `@acme_marketing_bot` | — | Marketing, content creation, SEO, social media |

---

## Reporting Hierarchy

```
product-director
├── pm-globex → globex-v2, globex-v1, globex-v1-2, globex-website, devops-globex, qa-forensics
├── pm-initech → initech-v2, devops-initech
├── pm-demosite → demosite, devops-demosite
└── pm-umbrella → umbrella-coding, devops-umbrella

atlas
├── sam
├── jordan
├── rae-biodata
└── acme-public
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
@acme_pm_globex_bot — can you check the status of issue #642?
```

**Rules:**
- Only works for agents with a Telegram handle
- The agent must be in the same Telegram group
- Don't mention agents you don't need — mentioning activates them
- Only one delegation per response

### 2. HTTP API (programmatic, local node)

Always name yourself (`senderAgentId`) and your run (`X-AgentX-Task`). The
daemon then answers at once with a **receipt**; it never makes you wait:

```bash
curl -s -m 10 -X POST http://127.0.0.1:19900/task \
  -H "Content-Type: application/json" \
  -H "X-AgentX-Task: $AGENTX_TASK_ID" \
  -d '{"agent": "<agent-id>", "message": "Your task description",
       "senderAgentId": "<your own agent id>"}'
```

This returns `202 {accepted, mode, taskId: "dlg-…", note}` right away:

- `mode: "callback"`: the answer arrives later as a new message in this
  conversation. Tell whoever asked you who you asked, then end your turn.
- `mode: "none"`: no turn of yours can be called back. You get a short
  notice on your next run when it ends; read the answer then with
  `agentx_lookup` (`handoff: "<taskId>"`) or
  `GET /a2a/delegations/<taskId>?as=<your id>`.

Do not wait for it, poll for it, or send it again (a repeat while it runs
returns the same `taskId` with `duplicate: true`). `stream: true` and
`async: false` do nothing for an agent: the receipt says `streamIgnored` or
`asyncIgnored`. A bare `curl /task` that names no agent is treated as a
script and holds your turn until the other agent finishes; never send one.

### 3. Mesh Task (cross-node, remote agents)

Name yourself here too: an agent always gets a receipt. Without
`async: true` the answer comes back to you (a callback, or a notice and a
read by id, as above); your `context` still goes to the remote node so it
keeps one conversation per chat. With `async: true` **and** a chat in
`context`, the answer goes straight to that chat instead.

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

This returns `202 {accepted, mode: "deliver", taskId: "dlg-…", deliverTo}`
immediately. The daemon holds the long call in the background and
**delivers the remote agent's answer straight to that chat** when it lands.
You do not wait, and you do not relay it yourself.

The one request that still waits is a `/mesh/task` to a guest host (a
machine this one joined as a guest): keep those short.

#### Why a receipt and not a longer timeout

A delegated agent run takes minutes. An agent's Bash tool kills any
command at **2 minutes**, and `curl -m 600` does NOT change that — the
tool's own timeout fires regardless of curl's. This has already lost real
work: a remote agent completed a full report 47 seconds after the call was
killed, and the user never saw it.

Raising the Bash timeout is not the fix either. It makes the delegation
only as reliable as the longest thing you can keep a socket open for.
The receipt removes the wait entirely.

#### `context` is the route home — it is not optional

`context.channel` and `context.chatId` are how the daemon knows where to
deliver the result. Without them:

- the request is **rejected** with 400 in async mode, and
- otherwise the task lands on the remote node as `api:default`,
  detached from the conversation that asked for it.

Pass the channel and chat id you were actually asked on.

#### Never promise to poll

**You cannot poll.** An agent turn is a single execution — when you reply,
you stop existing. Nothing wakes you when the remote agent finishes.
Saying "I'm polling for his report and will send it when it lands" is
stating something impossible, and it has been said to a user who then
received nothing.

The daemon brings the answer back (a callback, a delivery to the chat, or
a notice and a read by id). Say that instead: "Delegated to <agent> on
<peer>. His answer will arrive here when he's done." Then stop.

### 4. AgentX CLI

```bash
# Local agent
agentx daemon send <agent-id> "message"

# Remote agent via mesh
agentx daemon send <agent-id> "message" --peer hq-local
```

---

## Channels

| Channel | Details |
|---------|---------|
| **Telegram** | Multiple bots, one per agent. Group policy: mention-required. DM policy: pair. |
| **WhatsApp** | Atlas handles messages from `+10000000000` |
| **GitLab** | `gitlab.example.com` — webhooks route by project to the relevant PM agent |

**GitLab project → agent routing:**
- `globex/globex-system-v2` → `pm-globex`
- `globex/globex-website` → `globex-website`
- `acme/initech-v2` or `initech/initech-v2` → `pm-initech`
- `acme/demosite` → `pm-demosite`
- `*` (catch-all) → `atlas`

---

## When to Delegate vs Do It Yourself

- **Delegate** when the task belongs to another agent's domain (e.g., you're a PM and need a deploy — ask devops)
- **Do it yourself** when the task is within your own scope
- **Check landscape** when unsure who should handle something — the descriptions will guide you
