---
layout: home

hero:
  name: "AgentX"
  text: "Self-hosted multi-agent orchestrator"
  tagline: Route Telegram, WhatsApp, Discord, GitLab, crons, webhooks, and cross-machine mesh tasks to AI agents on Claude, OpenAI, or any LLM — with persistent memory, scheduled jobs, and a built-in business layer.
  actions:
    - theme: brand
      text: Get started
      link: /install
    - theme: alt
      text: View on GitHub
      link: https://github.com/anis-marrouchi/agentx

features:
  - icon:
      src: /icons/message-circle.svg
      alt: Channel routing
      width: 32
      height: 32
    title: Every channel, one router
    details: Telegram, WhatsApp, Discord, GitLab, webhooks, HTTP — built in. Agents reply on the channel they received on, or push to any other via cross-channel /send.
    link: /journey/01-telegram-qa-bot
    linkText: Build a Telegram bot
  - icon:
      src: /icons/alarm-clock.svg
      alt: Scheduled jobs
      width: 32
      height: 32
    title: Scheduled work that pages you on failure
    details: Cron jobs with timezone, retries, and an onError pipeline that can both notify you AND auto-disable after N failures.
    link: /journey/02-scheduled-reports
    linkText: Schedule a daily report
  - icon:
      src: /icons/users.svg
      alt: Multiple agents
      width: 32
      height: 32
    title: Multi-agent, multi-role
    details: Many agents sharing one channel, routed by @mention. Each agent is just a workspace directory — no code required.
    link: /journey/03-multi-agent-group
    linkText: Put a team in one group
  - icon:
      src: /icons/bar-chart-3.svg
      alt: KPI tracking
      width: 32
      height: 32
    title: Run a business with AI agents
    details: Day-cycle ticker, work-pool, KPI tracking, daily reporter. Your team clocks in, claims tasks, and produces a daily P&L.
    link: /journey/07-business-layer
    linkText: Turn agents into a team
  - icon:
      src: /icons/network.svg
      alt: Mesh federation
      width: 32
      height: 32
    title: Mesh across machines
    details: Agents on different machines collaborate over Tailscale/VPN. One roster, cross-node delegation, federated wiki.
    link: /journey/08-mesh-federation
    linkText: Federate two machines
  - icon:
      src: /icons/brain.svg
      alt: Knowledge base
      width: 32
      height: 32
    title: Compounding knowledge
    details: Karpathy-inspired wiki with a knowledge graph. Daily absorb turns raw conversations into cited articles the whole team can read.
    link: /concepts
    linkText: See the concepts
---

## Three ways to start

<div class="vp-doc">

**I want a chatbot on Telegram.** → [Journey 1 — Telegram Q&A bot](/journey/01-telegram-qa-bot)

**I want a scheduled job that pings me when it fails.** → [Journey 2 — Scheduled reports](/journey/02-scheduled-reports)

**I'm running a services team and want AI agents with KPIs.** → [Journey 7 — Business layer](/journey/07-business-layer)

</div>

## Install in 30 seconds

```bash
npm install -g agentix-cli
agentx init
agentx agent add
agentx channel add
agentx daemon start
```

See the [install guide](/install) for the full walkthrough.
