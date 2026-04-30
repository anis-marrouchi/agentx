---
title: "5. Hooks and webhooks"
---

# 5. Hooks and webhooks

> **Difficulty:** intermediate · **Time:** ~45 minutes

Two related but distinct extension points:

- **Hooks** run **inside** the agent's Claude Code session. They observe or block tool calls (`Bash`, `Edit`, `Write`), record file changes, gate destructive operations.
- **Webhooks** are **inbound** HTTP — Stripe, Sentry, GitHub, GitLab posting to your daemon. The daemon routes the payload to an agent, who reads it and acts.

This page covers both, with worked examples.

## What you'll build

**Part A.** A `Stop` hook that prevents an agent from running `rm -rf` on protected paths plus a `PreToolUse` hook that logs every `Edit`/`Write` to an audit channel.

**Part B.** A Stripe `payment_failed` webhook that fires a `billing` agent. The agent drafts a dunning message and posts it to the customer's Telegram thread.

## Hook types

Two type families in `.claude/settings.json`:

- `command` — shell command. Stdout captured; non-zero exit is a hook failure (which is what blocks a tool call).
- `http` — POST to a URL. The daemon offers `http://127.0.0.1:18800/hook/<event>/<agentId>` as a default endpoint.

Five events:

| Event | When it fires | Common uses |
|---|---|---|
| `PreToolUse` | Before any tool runs | Log file writes; gate destructive commands |
| `PostToolUse` | After a tool returns | Capture diffs; sync to git |
| `SessionStart` | New `--resume` session begins | Inject context; start a timer |
| `Notification` | Claude emits a notification (rare) | Forward to Slack |
| `Stop` | Session is terminating | Flush logs; commit pending changes |

The hook payload is JSON on stdin (for `command` hooks) or in the request body (for `http` hooks). Schema lives in `src/hooks/types.ts`.

## Adding a hook

Interactive:

```bash
agentx hook add devops-agent
```

The CLI walks you through event → type → matcher regex (e.g. `^Bash:.*rm -rf` to match destructive `Bash` calls) → command/URL.

Or hand-edit `.claude/settings.json` directly:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "type": "command",
        "command": "/usr/local/bin/audit-bash.sh",
        "blocking": true
      },
      {
        "matcher": "Edit|Write",
        "type": "http",
        "url": "http://127.0.0.1:18800/hook/PreToolUse/devops-agent",
        "blocking": false
      }
    ]
  }
}
```

`blocking: true` means non-zero exit / non-2xx response refuses the tool call. `blocking: false` is observe-only.

### Worked example: block destructive `rm -rf`

`/usr/local/bin/audit-bash.sh`:

```bash
#!/bin/bash
INPUT="$(cat)"
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Refuse rm -rf on these paths.
if echo "$COMMAND" | grep -qE 'rm\s+-rf\s+(/|/etc|/var|/home/[^/]+/?$)'; then
  echo "BLOCKED: refusing destructive rm against protected path" >&2
  exit 1
fi

# Otherwise log + allow.
echo "[$(date -Iseconds)] $COMMAND" >> /var/log/agentx-bash-audit.log
exit 0
```

Make it executable, restart the agent, and try to get it to `rm -rf /etc`. The hook exits 1, Claude sees the block, and the tool call never runs.

## Inbound webhooks

The daemon listens on the configured webhook port (`channels.gitlab.webhookPort`, default 18810; or the daemon's main HTTP port for the generic receiver). Two flavours:

| Endpoint | Used for | Routing |
|---|---|---|
| `POST /webhook/<agentId>[/<source>]` | Generic receiver | Direct to agent; `source` is just a tag |
| `POST /gitlab` (port 18810) | GitLab-only | Goes through `channels.gitlab.routes[]` |

The generic receiver is what Stripe, Sentry, GitHub etc. should target. The agent reads the raw payload as the message body.

### Signing

Set `secretEnv` on the webhook entry in `agentx.json` and the daemon will validate either:

- HMAC-SHA256 (`X-Hub-Signature-256` for GitHub-flavoured payloads)
- Plain shared secret in a custom header (Stripe-style `Stripe-Signature` is parsed by an agent-side helper, not the daemon — set `secretEnv` to the Stripe webhook secret and let the agent verify in code)

Webhooks without signing are rejected when `secretEnv` is set; without it, the endpoint is open. **Always set `secretEnv` on production webhooks.**

### Worked example: Stripe → Telegram

`agentx.json`:

```json
"webhooks": [
  {
    "id": "stripe-payments",
    "source": "stripe",
    "agentId": "billing",
    "secretEnv": "STRIPE_WEBHOOK_SECRET",
    "description": "payment_failed and payment_succeeded"
  }
]
```

In Stripe's dashboard, point the endpoint at `https://your-host:18800/webhook/billing/stripe`.

`billing` agent's `CLAUDE.md`:

> When you receive a Stripe webhook (channel=stripe), parse the JSON body. For event types `invoice.payment_failed`, look up the customer's Telegram chatId in `references/customers.yaml` and call `/send` with channel `telegram` and a short dunning message tagged with the invoice link.

The customer sees a Telegram message instead of an email; the agent's full reasoning lives in the per-agent task history; finance sees the same data on the [Live page](/reference/dashboard/live).

## Per-event-type workflow routing

For agents that need different workflows for different webhook events, set `triggers` on the webhook:

```json
"webhooks": [
  {
    "id": "github-ops",
    "source": "github",
    "agentId": "qa",
    "secretEnv": "GH_WEBHOOK_SECRET",
    "triggers": {
      "issues.opened": "triage-bug",
      "pull_request.synchronize": "rerun-tests",
      "release.published": "deploy-prod"
    },
    "defaultWorkflow": "log-only"
  }
]
```

The daemon reads the GitHub event-type header (`X-GitHub-Event`), joins it with the action (`issues.opened`), and dispatches the named [workflow](/reference/workflows). When no key matches, `defaultWorkflow` runs — useful as a catch-all logger.

## Debugging hooks and webhooks

Three good signals:

1. `agentx daemon logs -f | grep -E '(hook|webhook)'` — daemon-side line per fire.
2. The agent's `.claude/logs/` directory shows hook stdin/stdout for `command` hooks.
3. The [Admin → Webhooks tab](/reference/dashboard/admin#webhooks) shows the last 50 inbound payloads per webhook with body preview.

Common failure modes:

- **Hook fires but agent never sees the result.** `blocking: false` on a hook whose `command` exits non-zero — the daemon logs the failure but Claude doesn't see it. Use `blocking: true` if you want the tool blocked.
- **Webhook returns 401.** `secretEnv` is set but the request didn't include the signature header (or it didn't match). Test with the platform's "Send test event" button.
- **Webhook returns 200 but the agent is silent.** Check the routes — the daemon may have routed to a different agent. The [Admin → Webhooks tab](/reference/dashboard/admin#webhooks) shows the resolved agent for each fire.

## Next

- [Journey 6 — Shared wiki](/journey/06-shared-wiki): give the `billing` agent a customer-facts wiki it can cite.
- [Webhooks reference](/reference/config-schema#webhooks): full field reference, including per-agent secrets and mesh routing.
- [Hook fields in config schema](/reference/config-schema#agents-id) under `permissionMode` for the broader picker (when `bypassPermissions` is the wrong default).
