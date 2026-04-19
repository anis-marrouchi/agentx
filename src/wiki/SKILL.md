---
name: wiki
version: 3.1.0
description: Institutional knowledge wiki — cross-agent source of truth for people, projects, events, decisions, and patterns. Use `wiki query` BEFORE grep/workspace-memory when the question is about who / what happened / what we decided / how we do something.
argument-hint: "query <question> | status | ingest | absorb | share <article> <agent>"
tags: [wiki, knowledge, institutional, cross-agent, retrieval]
triggers:
  - pattern: "who is|who owns|what happened|what did we decide|history of|institutional|runbook|past incident|previous deploy"
    description: "Questions about persistent cross-agent knowledge"
---

# AgentX Institutional Wiki

You have access to a curated wiki that is **shared across all agents in the team**. It is the canonical source of truth for institutional knowledge. Your own workspace memory and per-project session history are LOCAL to you; the wiki is SHARED.

**When to use the wiki (imperative):**

- "Who is X / who owns Y" → query the wiki
- "What happened on DATE" / "past incident about Z" → query the wiki
- "What did we decide about X" → query the wiki
- "How do we do X" (team procedure, not code-level) → query the wiki
- "History of the MTGL deploys" / any "history of" question → query the wiki

**When NOT to use the wiki:**

- Live data (current GitLab MR status, current issue count) → use `gitlab` skill
- Code-level questions ("how does this function work") → read workspace files
- Real-time system status → use `mesh-awareness` or curl the daemon
- Anything you already know from the current conversation

## The primary command

```
agentx wiki query "your question"
```

If `agentx` is not on PATH, the exact invocation is provided in the `[Institutional Wiki]` block in your context — copy it verbatim. It's a `node /path/to/cli.js wiki query ...` call.

The command does three things:

1. Reads `_index.md` (the catalog organized by article type: person, project, place, concept, event, decision, pattern).
2. An LLM selector picks the candidate articles most relevant to the question.
3. Walks `related` wikilinks 2–3 hops from the candidates, then synthesizes an answer from the walked subgraph — with citations by article title.

You get back: a synthesized answer + a list of cited articles. Every factual claim is grounded in a wiki article.

## Other commands

| Command | When |
|---|---|
| `agentx wiki status` | How many articles exist per agent; am I running low on institutional knowledge? |
| `agentx wiki ingest` | Export recent conversations as raw wiki entries (cheap, just writes markdown) |
| `agentx wiki share <article> <agent>` | Share a private article you own with another agent |
| `agentx wiki migrate --dry-run` | Backfill `type` + `related` on legacy articles (operator-run, one-shot) |
| `agentx wiki prune --dry-run` | Collapse legacy mode dirs into graph/ (operator-run, one-shot) |
| `agentx wiki absorb [--max N]` | Compile unabsorbed entries into typed articles (Farzapedia-faithful; nightly cron) |

## Article types (the organizational spine)

- **person** — an individual human (team member, stakeholder, contact)
- **project** — a named initiative, repo, product, or service (also used for named agents)
- **place** — a physical or logical location (office, server, environment)
- **concept** — a recurring idea, philosophy, methodology
- **event** — a specific dated thing that happened (incident, deploy, launch)
- **decision** — a specific choice made and why (architecture, policy)
- **pattern** — a reusable workflow, template, or recipe

When you read a wiki answer, note the `[type]` tag on each citation — it tells you what kind of knowledge it is.

## Retrieval quality notes

The wiki uses an **agentic walk** of the article graph, not BM25 keyword search. This means:

- It handles questions like "what did we decide about the staging deploy" correctly — those need synthesis across multiple articles.
- It costs ~25 seconds per query (two LLM calls + file reads). Call it when you need it, not speculatively.
- If the wiki has no relevant article, the answer says so plainly. Don't invent.
- If a wiki answer contradicts something you believe, the wiki is usually right — it's the cross-agent authoritative source.

## When you should WRITE a wiki article

Only when the operator explicitly asks you to, OR when a task produces a durable, citable artifact (a runbook, an architectural decision, a person profile).

### Frontmatter (the exact shape — do not invent fields)

```yaml
---
title: "Article Title"
type: person | project | place | concept | event | decision | pattern
related: ["Other Article", "Another Article"]
tags: ["2-4-specific-tags"]
owner: <your-agent-id>
access: public | shared | private
shared_with: ["other-agent"]
created: YYYY-MM-DD
last_updated: YYYY-MM-DD
sources: ["entry-id-1"]
---
```

### Writing standards

- Wikipedia-style: flat, factual, encyclopedic. Not a diary entry.
- Synthesize — don't quote more than ~2 short lines.
- Organize by theme, not chronology.
- Use `[[wikilinks]]` inside the body for every referenced entity; list the same targets in `related` frontmatter.
- 20–100 lines. Articles over 100 lines should split.

## Access levels

| Content | Access |
|---|---|
| Project status, team decisions, procedures | `public` |
| Personal agent learnings, one-off patterns | `private` |
| Cross-team sensitive knowledge | `shared` with specific agents |
| Credentials, tokens, keys | `private` and encrypted — usually don't write at all |

## Gap flagging

If you query the wiki and no article covers the topic, add a one-line note to your final response:

```
Gap: <subject> — no wiki article covers this; <why it matters>
```

The operator decides whether to ask you to write one, or wait for the procedure-delta flow to land.
