---
title: "4. Cross-channel — GitLab MR → WhatsApp ping"
---

# 4. Cross-channel — GitLab MR → WhatsApp ping

> **Status:** planned (V2) · **Difficulty:** intermediate

::: warning This page is on the roadmap
A full walkthrough is planned for the next docs release. The underlying code is shipped — jump straight to the reference or follow the outline below.
:::

## Scenario (planned)

A GitLab merge request gets opened on a repo your `qa` agent watches. The agent reviews the diff, and when it finds a breaking change, it **pings the on-call engineer on WhatsApp** — not on GitLab. Humans get alerted on the channel they're actually watching; the audit trail stays on GitLab.

## Outline (what this page will teach)

- Configure the GitLab channel (`channels.gitlab.routes`, per-agent GitLab PAT, webhook secret)
- Enable the WhatsApp channel (Baileys QR pairing)
- The `POST /send` endpoint — how an agent triggers an outbound message on a different channel than the one it received on
- **H2A2H chain pattern** — human asks on GitLab, agent replies on WhatsApp
- Cascade prevention (how AgentX avoids notification loops)

## Today's nearest equivalents

- **Communication matrix** — every cross-channel path documented: [reference/communication-matrix](/reference/communication-matrix)
- **Send API** — `POST /send` payload shape lives in the communication matrix and [CLI reference](/reference/cli)
- **GitLab config fields** — [config-schema → channels.gitlab](/reference/config-schema#channels-gitlab)

## Contribute

If you hit this before V2 lands, a PR adding a worked example is welcome — the journey template is **Scenario → Prereqs → Config → Commands → Verify → Next**.
