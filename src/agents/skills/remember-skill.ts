// Source-of-truth for the `remember` skill body. Exported as a string
// constant so tsup bundles it into dist/ without needing an asset-copy
// step. The standalone `.md` file in this directory is a human-readable
// mirror kept in sync by hand; runtime installers read from here.

export const REMEMBER_SKILL_FILENAME = "remember.md"

export const REMEMBER_SKILL_BODY = `---
name: remember
description: Save a durable memory for yourself that will be inlined into your system prompt on every future session. Use when the user corrects your approach, confirms a non-obvious decision, reveals something durable about themselves or a project, or names an external resource you should reach back to. Writes go through the daemon's agent-memory HTTP API — no file system access required.
---

# Remember

You have a persistent memory layer that is auto-loaded into your system prompt on every task. It is SEPARATE from the shared wiki:

- **Wiki** is cross-agent, authoritative, documented. Facts that multiple agents agree on.
- **Memory** is yours alone, experiential. Things you learned the hard way, preferences that matter only for your work, pointers that help you navigate a specific user's stack.

Four memory kinds:

| Kind | Save something of type… |
|---|---|
| \`user\` | role, seniority, tone preference, what they are fluent in vs new to |
| \`feedback\` | corrections ("don't do X, we got burned last Q") + confirmations ("yes the bundled PR was right") |
| \`project\` | current initiative, known constraints, deadline context not in the code |
| \`reference\` | external systems and when to use them (Linear, Grafana, a specific dashboard URL) |

## When to save

**Good triggers** — save a memory whenever:

- The user corrects an approach ("no not that", "stop doing X"). Save as \`feedback\`.
- The user confirms a non-obvious approach worked ("yes exactly, keep doing that"). Save as \`feedback\`.
- You learn a durable fact about the user or their role you didn't know before. Save as \`user\`.
- You learn a project-level fact that is not in the code and not in the wiki. Save as \`project\`.
- The user points at an external system ("check Linear INGEST for ticket context"). Save as \`reference\`.

**Skip** — do NOT save:

- Conversation-specific state, current task TODOs, temporary context. Use the current session for those.
- Things already in the wiki, or that feel cross-agent authoritative. Propose a wiki article instead.
- Negative judgements about the user. Memories get re-read every session; stay professional.

## How to save

The daemon exposes \`POST /api/memory\`. Call it from a Bash tool invocation.

\`\`\`bash
curl -sS -X POST http://localhost:18800/api/memory \\
  -H 'Content-Type: application/json' \\
  -d '{
    "agentId": "<your-agent-id>",
    "type": "feedback",
    "name": "no-mock-db",
    "description": "Tests must hit a real database — mocks masked a prod migration bug in Q1.",
    "body": "In Q1 2026 the payments migration passed every mocked integration test but failed on prod because the mocks diverged from the real schema. Rule: integration tests run against a throwaway real database (we spin one up in CI). Reason: mock/prod divergence is a silent failure mode. How to apply: when a user asks for tests, propose a real DB setup; flag any suggestion to mock the DB."
  }'
\`\`\`

Your agent id is the name of the workspace directory you're in (e.g. \`atlas\`, \`mtgl-v2\`). When in doubt, run \`basename "$(pwd)"\`.

### Update an existing memory

Same endpoint, same \`name\`. The daemon keeps \`createdAt\` stable and bumps \`updatedAt\`. If you want to *append* rather than replace, pass \`"append": true\`:

\`\`\`bash
curl -sS -X POST http://localhost:18800/api/memory \\
  -H 'Content-Type: application/json' \\
  -d '{ "agentId":"atlas","type":"feedback","name":"no-mock-db",
        "description":"…", "body":"Also: 2026-04-15 hit the same class of bug on the grant-application webhook. Same rule.","append":true }'
\`\`\`

### Read what you already remember

Your CLAUDE.md already includes a sentinel block with every memory you've saved. Skim it first — if what you're about to save is already there, prefer updating the existing entry over creating a near-duplicate.

For the full JSON:

\`\`\`bash
curl -sS 'http://localhost:18800/api/memory?agent=atlas'
\`\`\`

### Remove

\`\`\`bash
curl -sS -X DELETE 'http://localhost:18800/api/memory/no-mock-db?agent=atlas'
\`\`\`

## Structuring the body

For **feedback** memories specifically, structure the body so future-you can judge edge cases instead of blindly obeying the rule:

\`\`\`
<the rule itself, one line>

Why: <the reason — often a past incident, a strong preference>
How to apply: <when/where this guidance kicks in>
\`\`\`

That's the same shape Claude Code's own memory system uses. Keeps the memory useful even when context shifts.

## Deduplication

Before saving, scan the AGENTX-MEMORY section of your CLAUDE.md. If a similar entry exists, prefer updating it over creating a new one — the index gets noisy otherwise.
`
