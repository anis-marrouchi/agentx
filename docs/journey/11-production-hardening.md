---
title: "11. Production hardening — permissions, debug, observability"
---

# 11. Production hardening — permissions, debug, observability

> **Status:** planned (V2) · **Difficulty:** advanced

::: warning This page is on the roadmap
Full walkthrough is coming. The tooling is shipped — outline below.
:::

## Scenario (planned)

Your agents have been running in `bypassPermissions` mode while you iterated. Now they're in production talking to real customers. You tighten permission modes, turn on the right debug categories, wire up `notifications.destination` for long-running tasks, and stand up an SSE event tap so your monitoring stack sees every agent turn.

## Outline (what this page will teach)

- **Permission modes** per agent (`default`, `acceptEdits`, `plan`, `bypassPermissions`, `yolo`) — when each is safe
- Glob allow/deny/confirm patterns inside `.claude/settings.json`
- Per-article wiki permissions (`private` / `shared` / `public`) for sensitive knowledge
- **Debug categories** — runtime toggle via `POST /debug/on?categories=webhook,cron,mesh` or env `AGENTX_DEBUG=…`
- **SSE event stream** — `curl -N http://localhost:19900/events` for external monitoring
- **`notifications`** block — daemon-wide pings for long-running tasks and errors
- systemd / launchd units for auto-restart
- Token-cost budgeting via `agentx usage serve` + per-agent `maxConcurrent`

## Today's nearest equivalents

- **Permission mode field** — [config-schema → agents.permissionMode](/reference/config-schema#agents-id)
- **Notifications block** — [config-schema → notifications](/reference/config-schema#notifications)
- **Debug categories list** — [reference/cli → Environment variables](/reference/cli#environment-variables)
- **systemd unit** — template in [install.md](/install#run-in-the-background)

## Why this is a separate page

Production concerns cut across every feature: channels, crons, mesh, wiki, business layer. A single page that walks you through lockdown + observability is more useful than one paragraph repeated in every feature doc.
