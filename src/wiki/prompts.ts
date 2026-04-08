import type { WikiMode } from "./hub"

/**
 * Two absorb prompts — same entries, different compilation strategies.
 */

export function buildAbsorbPrompt(
  mode: WikiMode,
  agentId: string,
  worldview: string,
  existingArticles: Array<{ title: string; path: string; tags?: string[] }>,
  entryTexts: string,
  entryCount: number,
): string {
  const existingList = existingArticles.length > 0
    ? `\nExisting articles:\n${existingArticles.map(a => `- ${a.title} [${(a.tags || []).join(", ")}] (${a.path})`).join("\n")}\n`
    : ""

  const worldviewSection = worldview
    ? `\n## Worldview\n\n${worldview}\n`
    : ""

  if (mode === "flat") return buildFlatPrompt(agentId, worldviewSection, existingList, entryTexts, entryCount)
  if (mode === "graph") return buildGraphPrompt(agentId, worldviewSection, existingList, entryTexts, entryCount)
  return buildUnifiedPrompt(agentId, worldviewSection, existingList, entryTexts, entryCount)
}

// --- Karpathy Flat: tags, LLM-chosen paths, gap detection ---

function buildFlatPrompt(
  agentId: string, worldview: string, existing: string, entries: string, count: number,
): string {
  return `You are a wiki editor for the "${agentId}" agent. Compile raw entries into a personal wiki.

## Karpathy Pattern

- Plain markdown files. YOU choose the path and structure — it emerges from the data.
- Tag AGGRESSIVELY. Tags are the #1 mechanism for context narrowing.
- Use [[wikilinks]] to cross-reference between articles.
- Synthesize — distill conversations into factual wiki articles, don't copy-paste.
- If an existing article covers the topic, produce an UPDATE with full merged content.
${worldview}${existing}
## Tagging Rules

Tag every article with ALL relevant dimensions:
- WHO: people, agents, teams (e.g., "alice", "deploy-bot", "cto")
- WHAT: project, client, topic, tech (e.g., "billing-api", "seo", "gitlab", "deploy")
- WHEN: dates, periods (e.g., "2026-04-06", "week-14")
- WHERE: server, environment, channel (e.g., "staging", "telegram", "production")
- HOW: type of knowledge (e.g., "process", "incident", "report", "decision")

Use section tags: \`<!-- tags: runbook, staging -->\`

## Gap Detection

After compiling, add a "gaps" array — topics MENTIONED but not yet covered.

## Output — ONLY valid JSON, no markdown fencing

{
  "articles": [
    {
      "path": "infra/staging-deploy.md",
      "title": "Staging Deployment Process",
      "tags": ["deploy", "staging", "devops", "process", "2026-04-06"],
      "content": "How we deploy to staging...\\n\\n## Steps\\n<!-- tags: runbook, staging -->\\n1. ...",
      "sources": ["entry-id-1", "entry-id-2"]
    }
  ],
  "gaps": ["Production server — mentioned but no article exists"]
}

ENTRIES (${count}):

${entries}`
}

// --- Knowledge Graph: kind, parent, hierarchy, events, entities ---

function buildGraphPrompt(
  agentId: string, worldview: string, existing: string, entries: string, count: number,
): string {
  return `You are building a knowledge graph for the "${agentId}" agent. Compile raw entries into a structured wiki.

## Knowledge Graph Model

Every article is a NODE with a kind and position in a hierarchy.
The path reflects the hierarchy: org/team/agent-name.md

### Node Kinds

**Entities** (things that persist):
person, agent, company, team, client, project, repo, server, service, domain

**Occurrences** (things that happen — always have a date):
event, incident, deploy, decision

**Knowledge** (what we know):
process, pattern, concept, report

### Rules

1. Ask: "What ENTITY is this about? What HAPPENED? Where in the hierarchy?"
2. Entities go under their parent: agent under team, server under project
3. Events go under events/YYYY-MM-DD/ and list which entities are involved
4. Path = hierarchy: org/<company>/<area>/<entity>.md
5. Use [[wikilinks]] to cross-reference between nodes
6. Synthesize — distill conversations into factual wiki content
7. If an existing article covers the topic, produce an UPDATE with full merged content
8. Tag aggressively too — tags help narrow context
${worldview}${existing}
## Gap Detection

After compiling, add a "gaps" array — entities or events MENTIONED but missing.

## Output — ONLY valid JSON, no markdown fencing

{
  "articles": [
    {
      "path": "org/team/marketing-bot.md",
      "title": "Marketing Bot — Content Agent",
      "tags": ["marketing-bot", "agent", "marketing"],
      "kind": "agent",
      "parent": "org/team",
      "content": "Marketing bot handles content and SEO.",
      "sources": ["entry-id-1"],
      "date": null,
      "involves": null
    },
    {
      "path": "events/2026-04-06/token-expiry.md",
      "title": "GitLab Token Expiry",
      "tags": ["incident", "gitlab", "2026-04-06"],
      "kind": "incident",
      "parent": "events/2026-04-06",
      "content": "The GITLAB_TOKEN expired, blocking deploys.",
      "sources": ["entry-id-2"],
      "date": "2026-04-06",
      "involves": ["org/clients/acme"]
    }
  ],
  "gaps": ["Production server — entity mentioned but missing"]
}

ENTRIES (${count}):

${entries}`
}

// --- Unified: best of both — flat's tags + graph's entity thinking ---

function buildUnifiedPrompt(
  agentId: string, worldview: string, existing: string, entries: string, count: number,
): string {
  return `You are compiling a personal wiki for the "${agentId}" agent.

## Your Job

Read ${count} raw conversation entries. For each, ask:
1. **Who** is mentioned? (people, agents, companies, teams)
2. **What** is this about? (project, server, tool, concept)
3. **What happened?** (deploy, incident, decision, report)
4. **What's missing?** (entities mentioned but undocumented)

Then compile articles — one topic per article, synthesized (not copy-pasted).

## How to Organize

- YOU choose the file path. Let structure emerge from the data.
- Use whatever directory names make sense: projects/, incidents/, agents/ — your call.
- Use [[wikilinks]] to cross-reference between articles.
- If an existing article covers the topic, produce an UPDATE with full merged content.
${worldview}${existing}
## How to Tag (CRITICAL)

Tags are how agents find relevant context. Tag EVERY article with ALL dimensions:

| Dimension | Examples |
|-----------|----------|
| **Who** | agent names, people, team names |
| **What** | project names, tools, technologies |
| **Type** | person, agent, server, project, incident, process, report, decision |
| **When** | 2026-04-06, week-14, q2-2026 |
| **Where** | staging, production, telegram, server-name |
| **How** | deploy, runbook, spike, review |

Minimum 6 tags per article. More is better.
Use section-level tags too: \`<!-- tags: runbook, staging -->\`

## How to Find Gaps

After compiling, identify MISSING PIECES:
- People mentioned but no article (e.g., "Alice gives deploy instructions but who is Alice?")
- Servers referenced but undocumented (e.g., "10.0.1.5 — what is this?")
- Processes implied but not written down (e.g., "deploy to staging — how exactly?")
- Projects named but no overview (e.g., "Project X — what is it?")

Be specific. "X is undocumented" is useless. "Alice — stakeholder who issues deploy instructions via Telegram, no profile article" is useful.

## Output — ONLY valid JSON, no markdown fencing

{
  "articles": [
    {
      "path": "agents/marketing-bot.md",
      "title": "Marketing Bot — Content Agent",
      "tags": ["marketing-bot", "agent", "marketing", "content", "seo"],
      "content": "Marketing bot handles content, marketing, and SEO.\\n\\n## Capabilities\\n<!-- tags: capabilities, tools -->\\n...",
      "sources": ["entry-id-1"]
    }
  ],
  "gaps": [
    "Alice — stakeholder who issues deploy instructions via Telegram, no profile article",
    "10.0.1.5 — production server IP referenced but no infrastructure article"
  ]
}

ENTRIES (${count}):

${entries}`
}
