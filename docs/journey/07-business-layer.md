# 7. Business layer — run a services team with AI agents

> **Difficulty:** advanced · **Time:** 30 minutes · **Ends at:** three agents that clock in at 9am, claim tickets from a backlog, report progress, and produce a daily summary

## Scenario

A small consulting firm has three AI teammates — **Alice** (marketing), **Bob** (dev), **Carol** (ops). You want them to:

1. **Clock in at 9am** and receive a daily standup prompt
2. **Pull work** from a shared backlog file (or GitLab)
3. **Claim and report** tasks — status, time spent, blockers
4. **Clock out at 6pm** with a daily summary posted to the team Telegram group
5. Leave a **KPI trail** you can review weekly

This is the **business layer** — a day-cycle ticker + work-pool + KPI store + reporter built on top of AgentX's core.

## Prerequisites

- Three agents configured (see [Journey 3](/journey/03-multi-agent-group))
- A Telegram group where the daily report lands (chatId noted)

## Set up via CLI

```bash
# Turn on the business layer + pick its main channel
agentx config set business.enabled true
agentx config set business.timezone Africa/Tunis
agentx config set business.mainChannel.channel telegram
agentx config set business.mainChannel.chatId -1001234567890
agentx config set business.mainChannel.accountId default

# Work pool
agentx config set business.workSource '{"type":"backlog","path":".agentx/backlog.md"}'
agentx config set business.workTickMinutes 15

# Role definitions (one object per role)
agentx config set business.roles.marketing '{
  "title": "Marketing Lead",
  "responsibilities": ["Content drafts","SEO monitoring","Lead triage"],
  "kpis": ["Published pieces per week","Lead response time"]
}'
agentx config set business.roles.dev '{
  "title": "Engineer",
  "responsibilities": ["Ship issues from backlog","Code review","Keep CI green"],
  "kpis": ["Issues closed per day","CI pass rate"]
}'
agentx config set business.roles.ops '{
  "title": "Operations",
  "responsibilities": ["Monitor production","Weekly cost report","Incident triage"],
  "kpis": ["Uptime","MTTR","Spend per week"]
}'

# Org chart — one entry per agent
agentx config set business.orgChart.alice '{
  "role": "marketing",
  "schedule": { "days": ["mon","tue","wed","thu","fri"], "start": "09:00", "end": "17:00" },
  "utilizationTarget": 0.75
}'
agentx config set business.orgChart.bob '{
  "role": "dev",
  "reportsTo": "carol",
  "schedule": { "days": ["mon","tue","wed","thu","fri"], "start": "09:00", "end": "18:00", "lunch": { "start": "12:30", "end": "13:30" } },
  "utilizationTarget": 0.8
}'
agentx config set business.orgChart.carol '{
  "role": "ops",
  "schedule": { "days": ["mon","tue","wed","thu","fri","sat"], "start": "08:00", "end": "16:00" },
  "utilizationTarget": 0.7
}'
```

Each call validates against the Zod schema and hot-reloads the daemon.

## What got written

For reference, the CLI above produces this `business` block:

```json
{
  "business": {
    "enabled": true,
    "timezone": "Africa/Tunis",
    "mainChannel": {
      "channel": "telegram",
      "chatId": "-1001234567890",
      "accountId": "default"
    },
    "workSource": {
      "type": "backlog",
      "path": ".agentx/backlog.md"
    },
    "workTickMinutes": 15,
    "idleQueueThreshold": 0,
    "roles": {
      "marketing": {
        "title": "Marketing Lead",
        "responsibilities": [
          "Content drafts (blog, social)",
          "SEO monitoring",
          "Lead intake triage"
        ],
        "kpis": ["Published pieces per week", "Lead response time"]
      },
      "dev": {
        "title": "Engineer",
        "responsibilities": [
          "Ship issues from backlog",
          "Code review teammates",
          "Keep CI green"
        ],
        "kpis": ["Issues closed per day", "CI pass rate"]
      },
      "ops": {
        "title": "Operations",
        "responsibilities": [
          "Monitor production",
          "Weekly cost report",
          "Incident triage"
        ],
        "kpis": ["Uptime", "MTTR", "Spend per week"]
      }
    },
    "orgChart": {
      "alice": {
        "role": "marketing",
        "schedule": { "days": ["mon","tue","wed","thu","fri"], "start": "09:00", "end": "17:00" },
        "utilizationTarget": 0.75
      },
      "bob": {
        "role": "dev",
        "reportsTo": "carol",
        "schedule": { "days": ["mon","tue","wed","thu","fri"], "start": "09:00", "end": "18:00", "lunch": { "start": "12:30", "end": "13:30" } },
        "utilizationTarget": 0.8
      },
      "carol": {
        "role": "ops",
        "schedule": { "days": ["mon","tue","wed","thu","fri","sat"], "start": "08:00", "end": "16:00" },
        "utilizationTarget": 0.7
      }
    }
  }
}
```

## The backlog file

The simplest work source is a GitHub-flavored markdown checklist at `.agentx/backlog.md`:

```markdown
# Backlog

- [ ] @alice Draft launch blog post [time: 2h]
- [ ] @alice Refresh LinkedIn banner [time: 30m]
- [ ] @bob Fix login redirect bug — issue #142 [time: 1h30m]
- [ ] @bob Migrate `/users` endpoint to v2 [time: 3h]
- [ ] @carol Rotate GitLab token on clawd-server [time: 45m]
- [ ] @carol Weekly cost review [time: 1h]
```

Each unchecked line is a work item. The **line number is the stable ID**, so the file stays readable. When an agent reports `done`, AgentX flips `[ ]` → `[x]` and appends `(done YYYY-MM-DD)`.

### Other work sources

```bash
agentx config set business.workSource '{"type":"gitlab","projects":["noqta/agentx","noqta/website"]}'
```

Pulls open GitLab issues assigned to each agent as work items.

```bash
agentx config set business.workSource '{"type":"wiki","path":".agentx/wiki/projects","glob":"**/*.md"}'
```

Treats every matching wiki article as a work item (useful for knowledge-curation teams).

## What the day-cycle does

Every minute, a ticker evaluates each agent against `orgChart[agent].schedule`:

| Event | When it fires | What the agent gets |
|---|---|---|
| **Standup** | First minute of the agent's schedule window, once per day | "It's 09:00 Monday. Here are your responsibilities, open work items, yesterday's KPI. Plan today in 3 lines." |
| **Work tick** | Every `workTickMinutes` during hours | "Pick the next item from your work pool, claim it, and start. Report when done." |
| **Wrap** | Last minute of the schedule window | "Summarize: what closed, what's blocked, what rolls to tomorrow." |
| **Day rollover** | Midnight in `timezone` | Per-agent state resets |

The `idleQueueThreshold` skips work ticks if the agent already has N queued messages (avoids piling up during standup bursts).

## Commands agents can call (via HTTP)

Each agent's context is injected with the business HTTP API (`src/business/http.ts`):

```bash
# List my open items
GET /business/work/list?agent=bob

# Claim one
POST /business/work/claim
{ "agent": "bob", "itemId": "backlog:3" }

# Report progress
POST /business/work/report
{ "itemId": "backlog:3", "status": "in-progress", "note": "debugging redirect loop" }

# Report done
POST /business/work/report
{ "itemId": "backlog:3", "status": "done", "timeSeconds": 4200 }

# Report blocked
POST /business/work/report
{ "itemId": "backlog:3", "status": "blocked", "blocker": "needs prod credentials" }

# Clock out (emits a per-agent KPI snapshot)
POST /business/clock-out
{ "agent": "bob" }
```

Agents don't usually call these directly — the prompts injected by the day-cycle do.

## KPIs

For each agent, AgentX tracks:

- Hours accrued on-clock
- Tasks completed / blocked
- Estimation accuracy (`estimatedSeconds` vs `timeSeconds`)
- Utilization vs `utilizationTarget`

Pull the current snapshot:

```bash
curl http://localhost:19900/business/kpi/today
curl http://localhost:19900/business/kpi/week
```

Or see token cost alongside:

```bash
agentx usage today
agentx usage serve --port 4300   # dashboard
```

## The daily reporter

At the end of each day, AgentX posts a summary to `business.mainChannel`:

```
Daily summary — Monday 2026-04-13

▸ alice (marketing) — 5h30m on clock, 3 tasks done, 1 blocked
  • Launch blog post draft (done, 1h45m vs 2h est)
  • LinkedIn banner (done, 20m)
  • SEO audit (blocked: need GSC access)

▸ bob (dev) — 7h20m on clock, 2 tasks done
  • Login redirect (done, 55m vs 1h30m est)
  • /users v2 migration (in progress, 4h logged)

▸ carol (ops) — 6h on clock, 2 tasks done
  • Token rotation (done, 40m)
  • Weekly cost review (done, 55m)

Team utilization: 73% (target 75%)
```

## Verify

1. Set each agent's `schedule.start` to a minute from now, `end` five minutes later.
2. Watch the daemon:
   ```
   [business] STANDUP → alice
   [alice] executing standup prompt
   [business] WORK-TICK → alice (3 open)
   …
   [business] WRAP → alice
   [business] daily summary posted to telegram:-1001234567890
   ```
3. Check `.agentx/backlog.md` — the items the agents claimed should be marked `[x]`.

## What's next

- **Spread the team across machines** → [Journey 8 — Mesh federation](/journey/08-mesh-federation)
- **Audit the full config schema** → [Reference — Config schema](/reference/config-schema)
