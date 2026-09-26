import { createHash } from "crypto"

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
  -H "X-AgentX-Task: $AGENTX_TASK_ID" \\
  -d '{
    "agentId": "<your-agent-id>",
    "type": "feedback",
    "name": "no-mock-db",
    "description": "Tests must hit a real database — mocks masked a prod migration bug in Q1.",
    "body": "In Q1 2026 the payments migration passed every mocked integration test but failed on prod because the mocks diverged from the real schema. Rule: integration tests run against a throwaway real database (we spin one up in CI). Reason: mock/prod divergence is a silent failure mode. How to apply: when a user asks for tests, propose a real DB setup; flag any suggestion to mock the DB."
  }'
\`\`\`

Your agent id is in \`$AGENTX_AGENT_ID\`. If that is empty, it's the name of the workspace directory you're in (e.g. \`atlas\`, \`globex-v2\`); run \`basename "$(pwd)"\`.

Always send \`X-AgentX-Task: $AGENTX_TASK_ID\`. It proves the change comes from you, and it's recorded as the memory's author. You can only change your own memory.

### Update an existing memory

Same endpoint, same \`name\`. The daemon keeps \`createdAt\` stable and bumps \`updatedAt\`. If you want to *append* rather than replace, pass \`"append": true\`:

\`\`\`bash
curl -sS -X POST http://localhost:18800/api/memory \\
  -H 'Content-Type: application/json' \\
  -H "X-AgentX-Task: $AGENTX_TASK_ID" \\
  -d '{ "agentId":"atlas","type":"feedback","name":"no-mock-db",
        "description":"…", "body":"Also: 2026-04-15 hit the same class of bug on the grant-application webhook. Same rule.","append":true }'
\`\`\`

### Don't overwrite a newer version

Every read returns an \`etag\`. To change a memory only if nobody has changed it since you read it, send that etag back as \`If-Match\`:

\`\`\`bash
curl -sS -X POST http://localhost:18800/api/memory \\
  -H 'Content-Type: application/json' \\
  -H "X-AgentX-Task: $AGENTX_TASK_ID" \\
  -H 'If-Match: "<etag from your read>"' \\
  -d '{ "agentId":"atlas","type":"feedback","name":"no-mock-db","description":"…","body":"…" }'
\`\`\`

A \`409\` means it changed in the meantime: read it again, merge your change in, and retry. Send \`If-None-Match: *\` to create a memory only if it doesn't exist yet.

### Read what you already remember

Your CLAUDE.md already includes a sentinel block with every memory you've saved. Skim it first — if what you're about to save is already there, prefer updating the existing entry over creating a near-duplicate.

For the full JSON:

\`\`\`bash
curl -sS 'http://localhost:18800/api/memory?agent=atlas'
\`\`\`

### Remove

\`\`\`bash
curl -sS -X DELETE 'http://localhost:18800/api/memory/no-mock-db?agent=atlas' \\
  -H "X-AgentX-Task: $AGENTX_TASK_ID"
\`\`\`

### History

Every change and removal is kept, so nothing is lost for good. List the versions, then restore one:

\`\`\`bash
curl -sS 'http://localhost:18800/api/memory/no-mock-db/versions?agent=atlas'
curl -sS -X POST 'http://localhost:18800/api/memory/no-mock-db/restore?agent=atlas' \\
  -H 'Content-Type: application/json' \\
  -H "X-AgentX-Task: $AGENTX_TASK_ID" \\
  -d '{"version":"<id from the list>"}'
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

/** Port the skill's examples are written against — the daemon default. */
const DEFAULT_PORT = 18800
const DEFAULT_URL = `http://localhost:${DEFAULT_PORT}/api/memory`

/** The skill body for a daemon listening on `port`. */
export function rememberSkillBody(port: number): string {
  return REMEMBER_SKILL_BODY.split(DEFAULT_URL).join(`http://localhost:${port}/api/memory`)
}

/** An installed skill that still calls the default port on a daemon that
 *  listens elsewhere, pointed at the right port. Only the API URL changes,
 *  so operator edits survive. Null when nothing needs to change. */
export function retargetRememberSkill(installed: string, port: number): string | null {
  if (port === DEFAULT_PORT || !installed.includes(DEFAULT_URL)) return null
  return installed.split(DEFAULT_URL).join(`http://localhost:${port}/api/memory`)
}

/** Fingerprint of a skill body with its port normalised away, so copies
 *  rendered for different daemons compare equal. */
export function skillFingerprint(body: string): string {
  const normalised = body.replace(/http:\/\/localhost:\d+\/api\/memory/g, "http://localhost:PORT/api/memory")
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16)
}

/** Every body agentx has shipped, including this one. An installed copy
 *  matching one of these was never edited, so replacing it with the
 *  current body loses nothing. Add the new fingerprint whenever the body
 *  changes (a test fails until you do). */
export const SHIPPED_SKILL_FINGERPRINTS: ReadonlySet<string> = new Set([
  "0d03ef39633b1b62", // first release: no port rendering
  "174abd4234f2b077", // generic example names
  "2a6ea8202d1fa0a0", // task header, conditional writes, history
])

/** What an installed skill should become: the current body when the copy
 *  is an unedited older release, else only the port retargeted, else
 *  null (leave it alone). */
export function upgradeRememberSkill(installed: string, port: number): string | null {
  const current = rememberSkillBody(port)
  if (installed === current) return null
  if (SHIPPED_SKILL_FINGERPRINTS.has(skillFingerprint(installed))) return current
  return retargetRememberSkill(installed, port)
}
