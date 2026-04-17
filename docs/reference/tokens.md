# Scoped API tokens

AgentX uses scoped tokens so external services (other AgentX instances, Slack bridges, custom apps, mesh peers) can call this daemon with exactly the permissions they need — no more.

Every token is:

- **Prefixed** with `agx_live_` so secret-scanners (GitHub, gitleaks) can catch leaked tokens.
- **Hashed** on disk (SHA-256) — the full secret is shown exactly once at creation time.
- **Scoped** to a set of actions. Presenting a token without the matching scope returns 403.
- **Optionally expiring** — set `--expires <days>` when you mint one.

Tokens live in `.agentx/tokens.json` alongside the daemon's data.

## Scopes

| Scope | What it allows |
|---|---|
| `dashboard:read` | Read `/api/live`, `/api/agents`, `/api/task/history`, static dashboard pages |
| `dashboard:write` | Everything in `dashboard:read` plus `/api/admin/*` (agents, channels, schedules, raw config) |
| `agent:<id>` | Call `POST /api/public/agents/<id>/messages` on that one agent |
| `agent:*` | Call the public endpoint on any agent (still needs the agent to be `access: "public"`) |
| `mesh:peer` | Reserved for cross-node mesh traffic |

Rule of thumb: **mint the narrowest scope that works**, and set an expiry.

## Create a token

From the CLI:

```bash
agentx token create --name "Slack bridge" --scope "agent:support" --expires 90
```

The output prints the full secret once. Copy it; it can't be recovered.

From the dashboard: open `/admin`, click the **Tokens** tab, fill in name + scopes + expiry, hit **Create token**. The secret is shown once in a copy-box that disappears after the next refresh.

## Use a token

HTTP Authorization header:

```bash
curl -H "Authorization: Bearer agx_live_<hex>" \
     -X POST http://127.0.0.1:4202/api/public/agents/support/messages \
     -H "Content-Type: application/json" \
     -d '{"message": "What's the refund policy?"}'
```

For endpoints that can't set a header (e.g. `EventSource` in the browser) you can pass `?token=agx_live_...` as a query parameter.

## List / revoke

```bash
agentx token list
agentx token revoke tok_abc123
```

Revoked tokens are refused immediately — no grace period. The record stays on disk (with `revokedAt`) for audit purposes.

## Legacy: `dashboard.token`

The older single-token setting in `agentx.json` still works for backward compatibility. When both are configured, either the legacy token OR a scoped token with `dashboard:write` satisfies the admin endpoints. For new installs, prefer scoped tokens.

## Security notes

- Tokens are plaintext on the wire — only use them over HTTPS when exposing the dashboard to the internet.
- `.agentx/tokens.json` should NEVER be committed. Add it to your `.gitignore` if you're versioning agentx configs.
- If you lose a token, revoke it and mint a new one. There is no recovery.
