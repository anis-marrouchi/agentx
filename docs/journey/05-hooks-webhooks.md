---
title: "5. Hooks and webhooks"
---

# 5. Hooks and webhooks

> **Status:** planned (V2) · **Difficulty:** intermediate

::: warning This page is on the roadmap
Full walkthrough is coming. The features are shipped — outline below.
:::

## Scenario (planned)

**Part A — receive:** Stripe sends a `payment_failed` webhook to your daemon. A `billing` agent reads it, drafts a dunning message, and posts it to the customer's Telegram thread.

**Part B — guard:** A `Stop`-event hook blocks the agent from running `rm -rf` on certain paths. A `PreToolUse` hook logs every file-write to an audit channel.

## Outline (what this page will teach)

- The generic webhook receiver: `POST /webhook/:agentId[/:source]`
- Parsing a Stripe / Sentry / GitHub payload inside an agent
- Registering a hook from the CLI: `agentx hook add <agent>`
- Hook events: `PreToolUse`, `PostToolUse`, `SessionStart`, `Notification`, `Stop`
- Hook types: `command` (shell) vs `http` (webhook callback)
- Writing a hook that **blocks** a tool call vs one that **observes**

## Today's nearest equivalents

- **CLI** — `agentx hook add` syntax: [reference/cli → Hooks](/reference/cli#hooks)
- **Webhook endpoint** — `POST /webhook/:agentId` in [reference/cli → HTTP endpoints](/reference/cli#http-endpoints)
- **Permission manager** — file-write safety modes are in [config-schema → agents](/reference/config-schema#agents-id) under `permissionMode`

## Contribute

PRs welcome. The hook system has 22 event types; a short table of each with a minimal command-type example would make this page ship.
