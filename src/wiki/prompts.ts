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
  return buildGraphPrompt(agentId, worldviewSection, existingList, entryTexts, entryCount)
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
- WHO: people, agents, teams (e.g., "nadia", "devops-agent", "anis")
- WHAT: project, client, topic, tech (e.g., "mtgl", "seo", "gitlab", "deploy")
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
      "path": "mtgl/staging-deploy.md",
      "title": "MTGL Staging Deployment",
      "tags": ["mtgl", "deploy", "staging", "devops", "process", "2026-04-06"],
      "content": "How we deploy MTGL to staging...\\n\\n## Steps\\n<!-- tags: runbook, staging -->\\n1. ...",
      "sources": ["entry-id-1", "entry-id-2"]
    }
  ],
  "gaps": ["MTGL production server — mentioned but no article exists"]
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
The path reflects the hierarchy: work/noqta/team/nadia.md

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
4. Path = hierarchy: work/<company>/<area>/<entity>.md
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
      "path": "work/noqta/team/nadia.md",
      "title": "Nadia — Marketing Agent",
      "tags": ["nadia", "agent", "noqta", "marketing"],
      "kind": "agent",
      "parent": "work/noqta/team",
      "content": "Nadia handles marketing for [[Noqta]].",
      "sources": ["entry-id-1"],
      "date": null,
      "involves": null
    },
    {
      "path": "events/2026-04-06/gitlab-token-expiry.md",
      "title": "GitLab Token Expiry",
      "tags": ["incident", "gitlab", "mtgl", "2026-04-06"],
      "kind": "incident",
      "parent": "events/2026-04-06",
      "content": "The GITLAB_TOKEN expired, blocking deploys for [[MTGL]].",
      "sources": ["entry-id-2"],
      "date": "2026-04-06",
      "involves": ["work/noqta/clients/mtgl"]
    }
  ],
  "gaps": ["MTGL production server — entity mentioned but missing"]
}

ENTRIES (${count}):

${entries}`
}
