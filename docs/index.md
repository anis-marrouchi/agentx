---
layout: home

hero:
  name: "AgentX"
  text: "AI operations layer for your team"
  tagline: For small & medium businesses. Plug in Telegram, WhatsApp, Slack, Discord, or GitLab, set schedules, and watch your agents work — on Claude, OpenAI, or any LLM. Web wizard for non-technical operators, CLI for engineers. Self-hosted.
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
    details: Telegram, WhatsApp, Slack, Discord, GitLab, webhooks, HTTP — built in. Agents reply on the channel they received on, or push to any other via cross-channel /send.
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
    details: Agents on different machines collaborate over Tailscale/VPN. One roster, cross-node delegation, federated wiki. Manage any peer's config from one dashboard.
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
  - icon:
      src: /icons/settings.svg
      alt: Admin panel
      width: 32
      height: 32
    title: Browser-based admin, no JSON editing
    details: Add agents, wire channels (QR-pair WhatsApp in the browser), schedule crons, mint scoped API tokens — all from the dashboard. CLI + agentx.json stay fully supported for power users.
    link: /install
    linkText: Start the wizard
  - icon:
      src: /icons/shield-check.svg
      alt: Scoped tokens
      width: 32
      height: 32
    title: Secure public agents
    details: Expose specific agents over HTTP with scoped, revocable bearer tokens. Read-only, write, per-agent, or mesh-peer scopes — no RBAC needed for a small team.
    link: /reference/tokens
    linkText: Tokens & public access
  - icon:
      src: /icons/list-checks.svg
      alt: Backlog and workflows
      width: 32
      height: 32
    title: Backlog import + workflow YAML
    details: Pull GitLab/GitHub issues into a structured backlog with two-way sync, or compose declarative state machines in YAML. Both feed the same work-pool and ledger.
    link: /playbooks/backlog-import-sync
    linkText: Import + sync upstream
  - icon:
      src: /icons/git-branch.svg
      alt: Plugins
      width: 32
      height: 32
    title: Extend with plugins
    details: Drop-in npm packages register custom channel adapters and bus subscribers. Mattermost, X, your internal tools — write a plugin once, ship it to every operator.
    link: /playbooks/plugin-authoring
    linkText: Author a plugin
  - icon:
      src: /icons/scale.svg
      alt: Org-chart governance
      width: 32
      height: 32
    title: Audit every dispatch
    details: Append-only ledger captures every routing decision; replay reproduces them deterministically. PM-gating, typed capabilities, and delegation-depth caps make admission control auditable.
    link: /playbooks/pm-gating
    linkText: Enable governance
  - icon:
      src: /icons/zap.svg
      alt: Actions registry
      width: 32
      height: 32
    title: Wire SaaS without code
    details: Register a HubSpot, Salesforce, Stripe, SendGrid, or Zendesk call once with typed inputs and templated secrets — call it from CLI, dashboard, workflows, or an agent prompt. No more curl-in-cron sprawl.
    link: /reference/actions
    linkText: Connect a SaaS API
---

## Three ways to start

<div class="vp-doc">

**I want a chatbot on Telegram.** → [Journey 1 — Telegram Q&A bot](/journey/01-telegram-qa-bot)

**I want a scheduled job that pings me when it fails.** → [Journey 2 — Scheduled reports](/journey/02-scheduled-reports)

**I'm running a services team and want AI agents with KPIs.** → [Journey 7 — Business layer](/journey/07-business-layer)

**I want to drive AgentX from Cursor / Claude Code.** → [Journey 10 — MCP server](/journey/10-mcp-server)

**I'm putting agents into production.** → [Journey 11 — Production hardening](/journey/11-production-hardening)

</div>

## Install in 30 seconds

**One line — opens the web setup wizard, no JSON editing:**

```bash
curl -fsSL https://raw.githubusercontent.com/anis-marrouchi/agentx/master/install.sh | bash
```

**Prefer Docker?**

```bash
git clone https://github.com/anis-marrouchi/agentx.git && cd agentx
cp agentx.example.json agentx-data/agentx.json    # or run `agentx setup` later
docker compose up -d
```

**Engineer shortcut:**

```bash
npm install -g agentix-cli
agentx setup          # opens the web wizard
# or skip the wizard:
agentx init && agentx agent add && agentx channel add && agentx daemon start
```

Then open **http://127.0.0.1:4202** for the dashboard — live agents, task history, Kanban, and the `/admin` panel. See the [install guide](/install) for advanced setups, Tailscale binding, and systemd.
