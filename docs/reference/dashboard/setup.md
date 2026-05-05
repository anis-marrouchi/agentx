# Setup wizard

Path: `/setup`

The setup wizard is a server-side state machine that walks new operators through the minimum needed to ship: a team name, one agent, optionally one channel, optionally an Anthropic API key. Output is a complete `agentx.json` and a scaffolded agent workspace.

## What you'll see

A multi-step form, one screen at a time, with a progress strip at the top. The steps adapt to what's already configured:

1. **Team & node identity.** Sets `node.id`, `node.name`, `dashboard.daemonUrl`.
2. **First agent.** Asks for an agent id, display name, and tier (`claude-code`, `codex-cli`, `sdk`, `orchestrator`). Scaffolds the workspace and `CLAUDE.md`.
3. **Channel (optional).** Telegram is offered first because it's the lowest-friction; the form embeds the BotFather link and verifies the token via `getMe` before writing it.
4. **Provider key (optional).** Only asked if the agent is API-backed (`sdk`/`orchestrator`). Stored in `.env` as `ANTHROPIC_API_KEY` (or the matching var) and referenced from `agentx.json` as `${ANTHROPIC_API_KEY}`.
5. **Done.** Shows the next step: dashboard tour, send a test message, link to the journey for the chosen channel.

## Behaviour on existing installs

If `agentx.json` already exists, the wizard runs in **extend mode** — every field defaults to the current value, and any step can be skipped. Submitting writes only the deltas; nothing is destructive. Safe to re-run any time.

## Common tasks

| You want to… | Do this |
|---|---|
| Add a second Telegram bot | Re-run the wizard, skip steps 1–2, add another account in step 3 |
| Switch tier on an agent | Use the [per-agent page](./agent) instead — the wizard only creates new agents |
| Reset everything | Stop the daemon, delete `agentx.json` + the agent's workspace, re-run the wizard |

## Troubleshooting

- **"Token rejected by Telegram."** The token has been revoked or BotFather generated a new one. Click **Regenerate token** in BotFather and paste the new value.
- **The wizard never shows the dashboard.** Make sure no other process is on port 4202 (`lsof -i :4202`) or pass `--port` to `agentx setup`.
- **Stuck on step 1 with "Node id already exists."** A prior partial run wrote `node.id`. Re-run with `--port` to a different port and pick a unique id, or open `agentx.json` and clear the field.

## Underlying state machine

`src/daemon/setup-wizard.ts`. Each step is idempotent — POSTing the same form twice produces the same `agentx.json`. The wizard never starts the daemon for you; click **Start daemon** at the end (or run `agentx daemon start` from the terminal).
