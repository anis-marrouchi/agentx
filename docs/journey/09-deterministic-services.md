---
title: "9. Deterministic services — WhatsApp workflows without an LLM"
---

# 9. Deterministic services — WhatsApp workflows without an LLM

> **Difficulty:** advanced · **Time:** ~40 minutes

Every prompt that goes to Claude costs tokens. For predictable requests with known inputs and a known output shape, paying for inference is wasteful — you already know the answer the LLM should produce, you just need the platform to produce it reliably.

AgentX's **services** layer sits between the channel router and the agent dispatcher. When a service trigger matches, the message is intercepted and a **fixed prompt** is sent to the agent — not the user's raw text. The user gets the right answer; you get deterministic costs and audit trails.

The newer **procedures** layer (added Phase 1 of the rescue) is a stricter sibling: a versioned SOP file the agent always references. This page covers both: services for "intercept and run", procedures for "always reference this when you do X".

## What you'll build

A `monthly report` service. A client texts `monthly report` (or `تقرير الشهر`) on WhatsApp; the daemon catches the message before it reaches an agent's LLM, runs a fixed report prompt, posts the CSV back. The same service auto-fires on the 1st of every month at 09:00 via its built-in `schedule` field.

## Procedures vs services

| | Service | Procedure |
|---|---|---|
| **Layer** | Pre-router intercept | Post-router reference |
| **Runs LLM?** | Yes — but with a fixed prompt | Yes — agent always sees procedure body in context |
| **Use when** | Known trigger phrase, known prompt | Agent sometimes does X, and X has a checklist |
| **Authored** | `services.<id>` in `agentx.json` | `.agentx/procedures/<id>.md` (frontmatter + body) |
| **CLI** | `agentx config set services.…` | `agentx procedure list/add/show` |

A service is "always do exactly this." A procedure is "the steps for X are in this file — reference them." Use a service for command-shaped requests; use a procedure for "how we deploy" or "how we triage a P1 outage."

## Authoring a service

`agentx.json`:

```json
"services": {
  "monthly-report": {
    "name": "Monthly KSI report",
    "triggers": [
      { "pattern": "^monthly report$", "channel": "whatsapp" },
      { "pattern": "^تقرير الشهر$",     "channel": "whatsapp" },
      { "pattern": "/monthly-report",   "channel": "telegram" }
    ],
    "allowedContacts": ["+1555...", "@manager"],
    "agent": "data-agent",
    "prompt": "Run the standing monthly KSI report query. Fetch from PG host=db.internal db=ksi. Output the CSV inline (no attachments).",
    "schedule": "0 9 1 * *",
    "timezone": "Africa/Tunis",
    "notify": {
      "channel": "whatsapp",
      "chatId": "+1555...@s.whatsapp.net"
    }
  }
}
```

Now:

- Inbound `monthly report` from `+1555...` on WhatsApp triggers the service. The agent receives the **service's `prompt`**, not the user's text. CSV comes back.
- Same trigger on Telegram works (different `pattern`).
- The 1st of every month at 09:00, the cron fires the same service automatically — output goes to `notify`.
- Anyone NOT in `allowedContacts` is ignored — service triggers don't fall through to the regular router for unauthorised contacts.

The deterministic surface is `triggers[].pattern` (regex), `allowedContacts`, `prompt`, optional `schedule`, optional `notify`. See [config-schema → services](/reference/config-schema#services-id) for the full field set.

## Authoring a procedure

```bash
agentx procedure add \
  --id deploy-clawd \
  --title "Deploy to clawd-server" \
  --trigger "When asked to ship a feature to the clawd DigitalOcean droplet" \
  --input "Branch name" \
  --input "Reload required (yes/no)" \
  --expected "Service is up after deploy; smoke-test passes" \
  --kpi "Mean time to recover < 5min on broken deploy" \
  --owner devops-agent \
  --tag "deploy,clawd" \
  --steps "## Steps

1. Build locally: pnpm build
2. Rsync dist/: rsync -avz dist/ clawd:/home/clawd/agentx/dist/
3. Re-install only if package.json changed: scp + pnpm install --prod
4. Restart: ssh clawd 'sudo systemctl restart agentx'
5. Verify: curl -fsS http://clawd-server:19900/health
6. Tail for 60s: ssh clawd 'sudo journalctl -u agentx -f'

## Notes
- Mac builds against Node v22; clawd runs Node v22. If pnpm install ran under a different Node, rebuild better-sqlite3 explicitly."
```

Then in the agent's CLAUDE.md, instruct the agent to call `agentx procedure show deploy-clawd` (or use the MCP tool surface) before any clawd deploy. The body is rendered into context as a verified reference; the agent follows the steps verbatim.

## Calling a procedure from an agent

Two paths:

1. **Manual** — the agent runs `agentx procedure show deploy-clawd` in a `Bash` tool call, reads the output, follows the steps. Works without any extra config.
2. **References integration** — set `contextReferences: true` on the agent and configure the references registry to point at procedures. The agent gets a `[Verified References]` block on every turn that includes the procedure body, so it never needs to fetch.

The references path is the lower-latency, lower-token-cost option once you have more than one procedure.

## Versioning

Procedure files live under `.agentx/procedures/<id>.md` and are git-tracked. Versioning is just `git log` — add a procedure → commit → reference it from `CLAUDE.md` → iterate. The `agentx procedure show` CLI prints the current version; the file's history is the audit trail.

For services, the same logic applies to `agentx.json`. Use `agentx config set` so each change validates and hot-reloads.

## Replay and idempotency

Services fire at most once per inbound message (the daemon dedupes by message id). When `schedule` is set, the cron fires once per scheduled time — the cron runner uses the same idempotency lock as `agentx schedule`.

For procedures, idempotency is the agent's responsibility — the procedure body should describe the safe-to-rerun behaviour explicitly. Good procedures begin with "Check whether step N already ran before doing it" for any non-idempotent step.

## Limits

- **Services run via the agent.** They cost LLM tokens (just deterministic ones). For zero-LLM work, use a [workflow](/reference/workflows) with a `procedure` node — workflows can call deterministic services without invoking Claude.
- **`triggers[].pattern` is a single regex per entry.** Use multiple entries for OR.
- **`allowedContacts` matches via substring** on phone numbers, JIDs, or `@usernames`. No regex, no glob.
- **`schedule` shares the cron pool** with `crons.<id>` — a service-with-schedule is a cron entry under the hood, just with the service's prompt.

## Next

- [Workflows reference](/reference/workflows): for multi-step deterministic flows that span agents.
- [Procedure CLI](/reference/cli#procedure-sops): list/add/show; delta extraction is on the roadmap.
- [Services config schema](/reference/config-schema#services-id): full field reference.
