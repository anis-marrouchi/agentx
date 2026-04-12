# Migrate from OpenClaw

If you're coming from an OpenClaw setup, `agentx migrate` imports the bulk of your config in one shot.

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
