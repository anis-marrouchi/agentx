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

## Pair the two nodes — one command each side

```bash
# On Node A (laptop, already running)
agentx connect mesh invite
# If the auto-detected URL is 127.0.0.1 or 0.0.0.0, you'll be prompted
# for the routable address (e.g. http://100.x.x.x:18800 over Tailscale).
# Output:
#   agentx-mesh://join/<base64-payload>
```

Copy the link, then:

```bash
# On Node B (VPS)
agentx connect mesh join "agentx-mesh://join/<...>"
# ✓ Joined mesh
#   Peer: laptop @ http://100.x.x.x:18800
#   Shared token stored in .env as MESH_TOKEN
#   Reachable — laptop exposes 2 agents
```

That's the whole pairing. `connect mesh invite` auto-generates a 64-char hex `MESH_TOKEN` (if one doesn't exist yet) and saves it to the inviter's `.env`; `connect mesh join` writes the same token to the other node's `.env` and adds the peer to `mesh.peers`. No manual token copying.

### What `connect mesh invite` actually does

1. Reads (or generates) `MESH_TOKEN` in `.env`
2. Confirms the URL peers should reach this node on (prompts if `node.bind` is `0.0.0.0` or `127.0.0.1`)
3. Flips `mesh.enabled` on via `applyConfigMutation`
4. Emits `agentx-mesh://join/<base64url(JSON{url,token,name,version})>`

### What `connect mesh join <link>` does

1. Decodes the payload
2. Prompts before overwriting a different existing `MESH_TOKEN`
3. Writes token to `.env`
4. Adds `mesh.peers[<name>] = { url, token: "${MESH_TOKEN}" }`
5. Health-checks the peer's `/.well-known/agent-card.json` for immediate feedback

### Workspace setup stays per-machine

`agentx connect mesh` only handles the mesh pairing — each node still needs its own agents configured:

```bash
# On each machine
agentx init                         # if not already
agentx agent add                    # run per agent
agentx config set node.id laptop    # set a human node name (used in invites)
agentx config set node.bind 0.0.0.0:18800
```

::: tip Security
Share the invite link over a trusted channel only (DM, not a public room). Whoever holds it can join your mesh. Rotate with `agentx connect mesh invite` again to emit a fresh token.
:::

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
