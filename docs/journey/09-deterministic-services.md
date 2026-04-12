---
title: "9. Deterministic services — WhatsApp workflows without an LLM"
---

# 9. Deterministic services — WhatsApp workflows without an LLM

> **Status:** planned (V2) · **Difficulty:** advanced

::: warning This page is on the roadmap
Full walkthrough is coming. The feature is shipped — outline below.
:::

## Scenario (planned)

A client texts `monthly report` (or `تقرير الشهر`) on WhatsApp. Instead of routing to an LLM, AgentX **intercepts the message before the agent** via a service matcher: regex + contact allowlist → runs a fixed SQL prompt → emits the CSV back. Same flow fires automatically on the 1st of every month via the same service's `schedule`. Zero token spend for known patterns.

## Outline (what this page will teach)

- The `services.<id>` config block (full schema in [config-schema → services](/reference/config-schema#services-id))
- Regex `triggers[]` with optional `channel` filter (English + Arabic patterns)
- `allowedContacts` — pattern-matching phone numbers for authorization
- `prompt` — the **fixed** prompt sent to the agent (not the user's raw text)
- Optional `schedule` — when the same service should fire on a cron
- `notify` — cross-channel delivery of results

## Today's nearest equivalents

- **Config reference** — full services schema: [config-schema → services](/reference/config-schema#services-id)
- **Example config** — the README originally shipped a deterministic monthly-report service as a reference snippet; the cleaned-up example lives at [`/examples/agentx.example.json`](/examples/agentx.example.json) (no services yet — PR welcome)

## Why this matters

Every prompt that goes to Claude costs tokens. For predictable requests with a known SQL / known API call, a service matcher is the right tool — the LLM only runs when a human needs interpretation.
