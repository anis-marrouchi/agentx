---
title: "Business processes with humans, agents, signals, and sub-workflows"
---

# Business processes

The workflow engine doubles as a lightweight **BPM** runtime — model an entire business activity as one DAG where humans submit forms, agents classify inputs, external systems fire signals, and child workflows run to completion.

This walkthrough builds a grant-application process that exercises **all four party kinds** in one workflow:

1. **Applicant** submits a form (human start)
2. **Agent** pre-screens eligibility (LLM)
3. **Reviewer** scores the application in Telegram or the web inbox (human advance)
4. **Finance system** posts a webhook to release disbursement (external advance)
5. **Closure letter sub-workflow** runs and completes (child advance)

## The story first

Alice is a grant officer at a small foundation. An applicant emails a 12-page grant proposal. Alice copies the proposal into the team's Telegram channel and tags `@grant-bot`.

Behind the scenes, agentx fires a workflow: an AI agent reads the proposal and produces a one-page summary; the workflow then routes the summary to Bob (a senior reviewer) by posting a form to his WhatsApp.

Bob fills the form (approve / approve-with-changes / decline) on his phone. If approved, the workflow triggers a webhook to the foundation's CRM (customer-relationship system). If declined, the workflow ends and posts the rationale back to Alice.

Total operator time: 15 seconds (Alice tagging the bot, Bob filling a form). Total agent time: ~2 minutes. The whole flow lives in **one YAML file** you'll see below — no glue code, no scheduler, no separate database.

## 1 · Register actors

```bash
agentx actor add anis --name "Anis M." \
    --telegram 123456789 --email anis@co.test --prefer telegram

agentx actor add sarah --name "Sarah L." \
    --whatsapp 21698111111 --email sarah@co.test --prefer whatsapp

agentx role create grant-reviewers --name "Grant Reviewers"
agentx role grant grant-reviewers actor:anis
agentx role grant grant-reviewers actor:sarah
```

That's it — no JSON editing. The store lives under `.agentx/actors/` and `.agentx/roles/`.

## 2 · Drop in the example workflows

The repo ships two JSON files you can copy verbatim:

```bash
mkdir -p .agentx/workflows
cp node_modules/agentix-cli/examples/workflows/grant-application.json .agentx/workflows/
cp node_modules/agentix-cli/examples/workflows/grant-closure-letter.json .agentx/workflows/
agentx workflow validate grant-application
```

The parent workflow includes a `subProcess` node pointing at `grant-closure-letter` — the child runs after the disbursement webhook signals success.

## 3 · Hand the first transition to an applicant

`trigger.form` nodes expose a simple HTTP form-start endpoint. For a manual kick-off:

```bash
curl -XPOST http://localhost:18800/workflows/grant-application/run \
  -H 'Content-Type: application/json' \
  -d '{
    "input": {
      "values": {
        "applicantName": "Nadia Khaled",
        "email": "nadia@example.test",
        "projectTitle": "Coastal literacy van",
        "description": "Mobile library stopping at 5 villages…",
        "amount": 12000
      },
      "submittedBy": "actor:nadia"
    }
  }'
```

The daemon creates a run, feeds the form values into the trigger node's output, and starts walking.

## 4 · What the reviewer sees

The agent pre-screens eligibility. If the `RESULT:` token is `eligible`, the run reaches a `userTask` node assigned to `role:grant-reviewers`. The engine resolves members and delivers to each preferred channel:

- **Anis** gets a Telegram message with two inline-keyboard URL buttons: `✓ Approve` and `✗ Reject`. One tap submits without opening the web inbox.
- **Sarah** gets a WhatsApp message with the same two URLs inline. Tap either link to submit.
- **Anyone** can also hit `/inbox?actor=actor:anis` in a browser and fill the form there.

For **approve-only** or richer forms with required fields, the renderer falls back to a deep link into the web inbox.

## 5 · Wait for the external webhook

After the reviewer approves, the run reaches a `signal.wait` node:

```json
{
  "id": "wait_disbursement",
  "type": "signal.wait",
  "config": { "name": "grant.disbursed", "match": { "grantId": "{{trigger.values.email}}" } }
}
```

Finance's internal system posts the signal when disbursement clears:

```bash
curl -XPOST http://localhost:18800/api/workflows/signal/grant.disbursed \
  -H 'Content-Type: application/json' \
  -d '{ "scope": "global", "payload": { "grantId": "nadia@example.test", "txRef": "TXN-992" } }'
```

Only runs whose `match` filter satisfies every key in the payload resume — the scope defaults to `workflow` but this one uses `global` so any listener on the daemon's bus can fire it.

## 6 · Child workflow runs to completion

With the disbursement confirmed, the parent reaches a `subProcess` node:

```json
{
  "id": "closure",
  "type": "subProcess",
  "config": {
    "workflowId": "grant-closure-letter",
    "inputMap": {
      "trigger": {
        "grantee": "{{trigger.values.applicantName}}",
        "email":   "{{trigger.values.email}}",
        "project": "{{trigger.values.projectTitle}}",
        "amount":  "{{trigger.values.amount}}"
      }
    },
    "awaitCompletion": true
  }
}
```

The parent **pauses**, the child run gets a fresh context seeded from `inputMap`, walks its own DAG (draft letter → manager approval → end), and when the child reaches `end`, the parent **resumes** with the child's output bundle. Nesting is capped by `workflow.maxChildDepth` (default 5) to prevent accidental runaway composition.

Open `/processes` — the dashboard renders the full composition tree plus SLA indicators (green/yellow/red) for every open `userTask`.

## 7 · KPIs

`/processes` includes a KPI strip at the top. The server-side aggregation (`GET /api/workflows/kpis`) computes per-actor:

- Open task count
- Completed count
- Average duration (created → submitted)
- SLA breach rate

Roll-up totals show across the whole workflow engine. Use this to spot which reviewer is bottlenecking, whose SLAs keep slipping, and whether throughput matches demand.

## What to try next

- Add a `timer.boundary` between the reviewer task and the next node. The run pauses for 48h, then auto-escalates to a manager role via a side path.
- Add a `gateway.parallel` fanOut before the reviewer task so finance and legal score in parallel, then `gateway.parallel` join before disbursement.
- Add a `rule` (DMN decision table) node to route by risk score + dollar amount without writing nested `branch` chains.
- Promote the `grant-closure-letter` sub-workflow to a sibling that's invoked from multiple parent flows — composition is flat, not baked in.
