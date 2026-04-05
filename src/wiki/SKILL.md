---
name: wiki
version: 1.0.0
description: Multi-agent knowledge wiki. Agents compile conversations and work into structured articles with permissions. Based on Karpathy/Farzapedia architecture.
argument-hint: "ingest | absorb [date-range] | query <question> | cleanup | share | status"
---

# AgentX Wiki — Multi-Agent Knowledge Base

You are a **writer** compiling a knowledge wiki from agent conversations and work sessions. Not a filing clerk. A writer. Your job is to read entries, understand what they mean, and write articles that capture understanding.

This wiki is shared across agents. Each article has an **owner** and **access level**:
- `private` — only you can read/write
- `shared` — you write, specific agents can read
- `public` — you write, all agents can read

## Commands

```
/wiki ingest        # Export recent conversations into raw entries
/wiki absorb        # Compile raw entries into wiki articles
/wiki query <q>     # Search and answer from wiki knowledge
/wiki cleanup       # Audit articles, fix links, enrich content
/wiki share <article> <agent> # Share a private article with another agent
/wiki status        # Show stats
```

## Directory Structure

```
.agentx/wiki/
  WIKI.md              # Master index (human-readable)
  _index.json          # Machine-readable index
  raw/entries/          # One .md per ingested entry
  projects/             # Project knowledge
  people/               # People and relationships
  decisions/            # Key decisions and reasoning
  patterns/             # Recurring patterns and insights
  concepts/             # Technical concepts and learnings
  {emerge}/             # New directories emerge from data
```

## Writing Articles

### Frontmatter

```yaml
---
title: "Article Title"
type: project | person | concept | decision | pattern | event
owner: marketing-agent
access: public | shared | private
shared_with: ["devops-agent", "atlas"]
created: 2026-04-05
last_updated: 2026-04-05
related: ["[[Other Article]]", "[[Another]]"]
sources: ["entry-id-1", "entry-id-2"]
tags: ["mtgl", "deployment"]
---
```

### Permission Guidelines

Choose access level based on content:

| Content | Access | Why |
|---------|--------|-----|
| Project status, architecture | `public` | All agents benefit |
| Meeting notes, decisions | `public` | Transparency |
| Personal agent learnings | `private` | Agent-specific patterns |
| Sensitive credentials, keys | `private` | Security |
| Cross-team insights | `shared` | Relevant agents only |
| Draft strategies | `shared` | Share when ready |

### Writing Standards

- Write like Wikipedia. Flat, factual, encyclopedic.
- **This is not Wikipedia about the thing. This is about the thing's role in our work.**
- A page about MTGL isn't a product description. It's about deployment patterns, decisions made, issues encountered.
- Let facts imply significance. No peacock words.
- Articles organized by **theme, not chronology**.
- Maximum 2 direct quotes per article.
- Every article must have a point. Not "here are 4 times X happened" but "X represents Y in our workflow."

### Article Types

| Type | Structure | Length |
|------|-----------|--------|
| project | Architecture, decisions, current state, issues | 40-100 lines |
| person | Role, interactions, preferences | 20-50 lines |
| concept | What it is, how we use it, lessons | 30-60 lines |
| decision | Context, options, reasoning, outcome | 30-50 lines |
| pattern | Trigger, cycle, how to handle | 30-60 lines |
| event | What happened, impact, follow-ups | 20-40 lines |

## Absorbing Entries

Process entries chronologically. For each:

1. **Read the entry.** Understand what it means, not just what it says.
2. **Match against the index.** What existing articles does this touch?
3. **Update or create articles.** Re-read every article before updating.
4. **Set permissions.** Default to `public` unless content is sensitive or agent-specific.
5. **Connect.** Use `[[wikilinks]]` between articles. Find patterns.

### Anti-Cramming

If you're adding a third paragraph about a sub-topic to an existing article, that sub-topic probably deserves its own page.

### Every 10 Entries: Checkpoint

1. Rebuild index
2. Count new articles (if zero, you're cramming)
3. Check articles over 100 lines (should split?)
4. Verify permissions make sense

## Querying

1. Read `_index.json` to find relevant articles
2. Only read articles you have permission to access
3. Follow `[[wikilinks]]` 2-3 links deep
4. Synthesize across articles. Cite by name.
5. Never read raw entries. The wiki IS the knowledge.

## Token Optimization

This wiki exists to save tokens. Instead of replaying entire conversation histories:
- Agents read 2-3 relevant articles before responding (~1K tokens vs ~10K for session history)
- Articles are distilled knowledge, not raw transcripts
- The absorb step compresses many conversations into focused articles
- Stale knowledge gets cleaned up, not accumulated
