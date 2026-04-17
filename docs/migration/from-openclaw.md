# Migrate from OpenClaw

## When to switch

[OpenClaw](https://github.com/openclaw/openclaw) is a great single-user personal assistant. You'll feel the pinch the moment you need more than one:

- **More than one operator** — multiple people managing the same set of agents, sharing dashboards and logs.
- **More than one machine** — agents on a laptop + a server that share work without you copying configs around. AgentX calls this the [team network](../journey/08-mesh-federation.md) and sets it up automatically.
- **Scheduled work** — cron jobs with retries, failure alerts, and a built-in natural-language scheduler (`agentx schedule "every Monday at 9am" --agent sales`).
- **A shared Kanban / board view** — a browser Kanban that drags GitLab issues between columns is shipped in AgentX; OpenClaw is chat-first.
- **Cost + KPI tracking** — a "Today" strip on the live dashboard showing tasks handled, time, tokens, and per-channel breakdown; business-layer KPIs per agent.

If none of those match, **stay on OpenClaw.** It has the lighter install path and the simpler mental model. When you outgrow it, `agentx migrate` imports the bulk of your config in one shot.

## Command

```bash
agentx migrate openclaw                    # reads default OpenClaw config path
agentx migrate openclaw ./openclaw.json    # explicit path
agentx migrate openclaw --dry-run          # preview without writing
```

The migrator produces (or updates) `agentx.json` in the current directory and scaffolds Claude Code workspaces for each imported agent.

## What gets imported

| OpenClaw | AgentX equivalent |
|---|---|
| Agents + personalities | `agents.<id>` + bootstrap files in the agent's workspace |
| Telegram accounts | `channels.telegram.accounts` |
| Channel-agent bindings | `channels.*.agentBinding` / `mentions` |
| Scheduled jobs | `crons.<id>` with cron syntax |
| Project metadata | `node.name`, agent workspace descriptions |

## What doesn't auto-migrate

- Secrets — tokens are referenced as `${TG_…_BOT_TOKEN}`; you populate `.env` manually
- Custom OpenClaw plugins — rewrite as AgentX hooks or MCP servers
- Business-layer style rules — re-author under `business.*` in `agentx.json` (see [Journey 7](/journey/07-business-layer))

## After migration

1. Populate `.env` with the tokens the migrator listed
2. Run `agentx config check` — it surfaces any missing references
3. Start the daemon: `agentx daemon start`
4. Watch: `agentx daemon watch`

## Rollback

The migrator writes a timestamped backup `agentx.json.bak.<timestamp>` before overwriting. Restore with:

```bash
cp agentx.json.bak.<timestamp> agentx.json
```
