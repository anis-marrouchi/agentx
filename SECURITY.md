# Security

AgentX runs LLM agents that can act — send messages, touch repos, execute tools. We treat the daemon as security-sensitive infrastructure and try to make the honest choice the default one. This document describes the threat model, what the daemon enforces, what it cannot enforce, and how to report problems.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](../../security/advisories/new) (Security → Report a vulnerability). If that's not possible, email anis.marrouchi@noqta.tn with "SECURITY" in the subject. We aim to acknowledge within 48 hours. Please don't open public issues for exploitable problems before we've had a chance to ship a fix.

## Defaults that matter

| Surface | Default | Notes |
| --- | --- | --- |
| HTTP API bind | `127.0.0.1:18800` — loopback only | Nothing is reachable from the network unless you change `node.bind`. |
| Mesh endpoints (`/task`, `/mesh/task`, `/workflow/*`, `/channel/send`, `/webrtc/signal`) | Bearer-token verified for non-loopback callers | Tokens come from `MESH_TOKEN` / per-peer tokens created by `agentx connect mesh`. Installs with no token configured still work but log a warning on every unauthenticated call; that grace path will be removed. |
| Telemetry | None | Nothing leaves your machines. Config is `agentx.json` + SQLite on disk. |
| Secrets | Env vars (`.env`), referenced from config as `${VAR}` | `agentx.json`, `.env`, and backups are gitignored. Never commit them. |
| Agent-to-agent delegation | Depth-capped (max 3 hops) | Prevents mention loops and runaway bot-to-bot chains. |
| File writes (orchestrator tier) | Permission manager with allow/deny/confirm globs | `permissionMode` is per-agent config; `bypassPermissions` is opt-in and should be reserved for sandboxed workspaces. |
| Dispatch audit | Append-only intent ledger (SQLite) | Every routing decision (channel, mesh, cron, workflow) is recorded and replayable — when an agent does something surprising, you can reconstruct why. |

## Threat model

**In scope — the daemon defends against:**

- Unauthenticated network callers dispatching agent tasks or messages (mesh token verification, loopback-only default bind).
- One compromised or confused agent chain-triggering unbounded work (delegation depth cap, per-agent queue modes).
- Silent actions: everything dispatched goes through the ledger; there is no side channel for an agent to receive work the ledger doesn't see.
- Credential sprawl: tokens live in env vars, are never interpolated into prompts, and mesh routing hands peer-owned tokens only to the peer that owns them.

**Out of scope — what you must handle operationally:**

- **Prompt injection.** No agent product has solved this. An agent that reads untrusted content (web pages, issues, inbound chat) can be manipulated. Mitigate by scoping what each agent can do: dedicated workspaces, minimal channel bindings, `permissionMode` restrictions, and separate agents for untrusted input vs. privileged actions.
- **The LLM provider.** Prompts and context go to whichever provider the agent's tier uses (Claude, OpenAI-compatible, or your own endpoint). Self-host the model if that's unacceptable.
- **Host security.** The daemon runs with your user's privileges. Agents on the `claude-code` tier execute a real CLI with real filesystem access in their workspace.
- **Network exposure.** If you change `node.bind` to a routable address, put it inside a private network (Tailscale/WireGuard) — mesh tokens authenticate peers, but the admin dashboard and read endpoints are designed for trusted networks, not the public internet.

## Hardening checklist for mesh / multi-node setups

1. Pair nodes with `agentx connect mesh` — it generates a 32-byte `MESH_TOKEN` and wires peers with `${MESH_TOKEN}` references. Share invite links over a trusted channel only.
2. Keep `node.bind` on `127.0.0.1` unless peers need to reach the node; when they do, bind to the tailnet address, not `0.0.0.0`.
3. One agent, one job: separate the agent that reads public input from the agent that holds write tokens.
4. Prefer scoped, per-project tokens (GitLab project tokens, repo-scoped PATs) over account-wide credentials in `.env`.
5. Review the ledger (`agentx ledger`) and the dashboard's activity views — they exist so surprises are auditable.
6. Run `agentx doctor` after config changes; it flags common exposure mistakes.

## Supported versions

Security fixes land on the latest minor release (`master`). There are no LTS branches; upgrading is the patch path.
