# 8. Mesh federation — laptop + VPS, one team

> **Difficulty:** advanced · **Time:** 20 minutes · **Ends at:** two machines running AgentX, sharing one agent roster, delegating tasks across the mesh

## Scenario

Your laptop runs **marketing** and **support** agents — they handle Telegram traffic while you work. A VPS runs **devops** and **qa-forensics** — they handle CI webhooks, scheduled deploys, and production incidents 24/7. You want:

- One logical team across both machines
- Cross-machine delegation (`@devops` works no matter which node you're chatting on)
- Wiki syncing so both machines share the knowledge base

## Why Tailscale / private network

Agent-to-agent traffic is un-TLS'd JSON over HTTP. You must not expose the mesh port to the public internet. Tailscale gives every machine a stable private IP (`100.x.x.x`) with WireGuard encryption. WireGuard, Nebula, or a VPN also work. We'll assume Tailscale.

## Prerequisites

- Tailscale (or equivalent) installed on both machines, both machines online on the same tailnet
- AgentX installed on both (see [install](/install))
- A shared `MESH_TOKEN` secret in both `.env` files — required for peer auth

## Set up via CLI

### Machine A (laptop)

```bash
agentx init
agentx agent add     # run twice — marketing, support
agentx config set node.id laptop
agentx config set node.bind 0.0.0.0:18800

# Mesh: name + url + token placeholder that resolves from .env
agentx config set mesh.enabled true
agentx mesh add     # interactive: name=clawd-server, url=http://100.67.108.119:19900, token=${MESH_TOKEN}
```

Drop a matching `MESH_TOKEN` in `.env` (any long random string; must match on both machines):

```bash
openssl rand -hex 32 | tee -a .env | awk '{print "MESH_TOKEN="$1}'   # one-liner
# or edit .env manually — it's a single line
```

### Machine B (VPS, e.g. `clawd-server`)

```bash
agentx init
agentx agent add     # run twice — devops, qa-forensics
agentx config set node.id clawd-server
agentx config set node.bind 0.0.0.0:19900

agentx config set mesh.enabled true
agentx mesh add      # peer: name=laptop, url=http://100.x.x.x:18800, token=${MESH_TOKEN}
```

Put the **same** `MESH_TOKEN` in this machine's `.env`.

> PR 4 of the UX v2 roadmap introduces `agentx mesh invite` / `agentx mesh join <url>` so this token exchange happens via a single-use link. For now: copy the same secret to both `.env` files.

## Start both daemons

```bash
# Laptop
agentx daemon start

# VPS (over SSH, or via systemd)
agentx daemon start --detach
```

On startup each node fetches the other's **agent card** from `GET /.well-known/agent-card.json`:

```json
{
  "node": "clawd-server",
  "agents": [
    { "id": "devops", "name": "DevOps", "mentions": ["@devops"], "skills": ["deploy", "incident"] },
    { "id": "qa-forensics", "name": "QA Forensics", "mentions": ["@qa"], "skills": ["trace", "root-cause"] }
  ]
}
```

The router merges local agents + remote agents into one landscape. `@devops` on the laptop now routes over HTTP to the VPS.

## Verify the mesh

```bash
agentx mesh list
```

```
NAME           URL                           STATUS   AGENTS
clawd-server   http://100.67.108.119:19900   ✓ ok     devops, qa-forensics
```

Send a task across:

```bash
agentx daemon send devops "Check disk free on /var/log" --peer clawd-server
```

Or from inside a chat on the laptop, mention `@devops` — the router detects it's a remote agent and forwards via HTTP with SSE streaming of the response.

## Cross-mesh messaging from anywhere

```bash
curl -X POST http://localhost:18800/mesh/task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MESH_TOKEN" \
  -d '{"peer":"clawd-server","agent":"devops","message":"Run health check"}'
```

The response is a streamed SSE feed of the remote agent's reply.

## Wiki federation

Each agent has its own wiki. With mesh enabled, you can sync raw entries from peers:

```bash
agentx wiki sync                  # pulls from all configured peers
agentx wiki sync --peer clawd-server
agentx wiki absorb                # compile into articles locally
```

Or serve a federated view:

```bash
agentx wiki serve --port 4200     # auto-discovers peers from config
```

Open `http://localhost:4200` to browse local + remote agent wikis in one Wikipedia-style UI.

## Security notes

1. **Never expose the mesh port to the public internet.** Bind to `100.x.x.x` (Tailscale) or `127.0.0.1` with a reverse SSH tunnel.
2. `MESH_TOKEN` must be long and random (≥32 bytes). Rotate by updating both `.env` files and restarting.
3. Tailscale ACLs can restrict which tailnet nodes may reach the mesh port.

## Troubleshooting

- `✗ clawd-server — Connection refused` → daemon down on remote, firewall blocks the port, or Tailscale not connected
- `✗ clawd-server — 401` → `MESH_TOKEN` mismatch between the two `.env` files
- Remote agent mentions unknown → agent cards don't refresh instantly; wait one health-check interval (default 60s) or restart

## What's next

- **Add daily wiki absorb to both nodes** → [Journey 2 — Scheduled reports](/journey/02-scheduled-reports) (same pattern, `prompt: "node dist/cli.js wiki absorb --max 20"`)
- **All mesh + wiki CLI flags** → [Reference — CLI](/reference/cli)
