import type { Workflow } from "./types"
import type { WorkflowStore } from "./store"
import type { ActorStore } from "../actors/store"

// --- Workflow-builder chat context ---
//
// Produces the plain-text prompt the authoring agent reads. Packs
// *everything* the agent needs to generate a valid V2 workflow JSON on
// its first try: node catalog with config examples, available agent
// ids, actor + role ids, channel adapter names, the user's existing
// workflow list (for subProcess targets), and — when the author is
// editing — the current workflow JSON as a starting point.
//
// The output is deliberately text, not JSON. Agents (LLMs) produce
// better structured output when the schema is described as prose +
// examples rather than as raw JSON Schema. The explicit "reply with a
// ```json block```" instruction at the tail is what the API endpoint
// parses back.

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface BuildContextArgs {
  messages: ChatMessage[]
  store: WorkflowStore
  actors: ActorStore
  /** Full list of agent ids + optional descriptions. */
  availableAgents: Array<{ id: string; description?: string; tags?: string[] }>
  /** Adapter names the daemon has live (telegram, whatsapp, gitlab, ...). */
  availableChannels: string[]
  /** The workflow the user is currently editing (if any). */
  currentWorkflow?: Workflow
}

/** Build the single-string prompt the agent executes. */
export function buildWorkflowAuthorPrompt(args: BuildContextArgs): string {
  const workflows = args.store.list().map((w) => ({ id: w.id, title: w.title }))
  const actorIds = args.actors.listActors().map((a) => a.id)
  const roleIds = args.actors.listRoles().map((r) => r.id)

  const parts: string[] = []

  parts.push(SYSTEM_HEADER)
  parts.push("")
  parts.push(NODE_CATALOG)
  parts.push("")
  parts.push("# Environment — only reference values that exist")
  parts.push("")
  parts.push(`## Available agents (for \`agent\` nodes)`)
  if (args.availableAgents.length === 0) {
    parts.push("  (none registered — the user must add an agent first for `agent` nodes to work)")
  } else {
    for (const a of args.availableAgents) {
      parts.push(`  - \`${a.id}\`${a.description ? ` — ${a.description}` : ""}`)
    }
  }
  parts.push("")
  parts.push("## Available actors (for `userTask.assignTo`)")
  if (actorIds.length === 0) {
    parts.push("  (none — user must register actors with `agentx actor add <id> …` before workflows can use `userTask`)")
  } else for (const id of actorIds) parts.push(`  - \`${id}\``)
  parts.push("")
  parts.push("## Available roles (for `userTask.assignTo`)")
  if (roleIds.length === 0) parts.push("  (none)")
  else for (const id of roleIds) parts.push(`  - \`${id}\``)
  parts.push("")
  parts.push("## Available channels (for `action.*` and `trigger.channel`)")
  parts.push(`  ${args.availableChannels.length ? args.availableChannels.map((c) => `\`${c}\``).join(", ") : "(none live on this node)"}`)
  parts.push("")
  parts.push("## Existing workflows (for `subProcess.workflowId`)")
  if (workflows.length === 0) parts.push("  (no other workflows defined)")
  else for (const w of workflows) parts.push(`  - \`${w.id}\` — ${w.title}`)
  parts.push("")

  if (args.currentWorkflow) {
    parts.push("# Current workflow on canvas")
    parts.push("")
    parts.push("The user is editing this workflow. Build on it — do NOT replace it unless they explicitly ask.")
    parts.push("")
    parts.push("```json")
    parts.push(JSON.stringify(args.currentWorkflow, null, 2))
    parts.push("```")
    parts.push("")
  }

  parts.push("# Conversation")
  parts.push("")
  for (const m of args.messages) {
    const tag = m.role === "user" ? "USER" : "ASSISTANT"
    parts.push(`${tag}: ${m.content}`)
    parts.push("")
  }

  parts.push(RESPONSE_RULES)
  return parts.join("\n")
}

/** Try to extract a workflow-shaped JSON block from an agent reply. Returns
 *  null if no JSON block is present OR the JSON doesn't have the minimum
 *  workflow fields (id, nodes). The caller still runs full zod validation
 *  before writing. */
export function extractWorkflowJson(reply: string): Record<string, unknown> | null {
  // Prefer fenced ```json blocks; fall back to the largest {...} block.
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(reply)
  const candidates: string[] = []
  if (fenced) candidates.push(fenced[1])
  const braceMatch = reply.match(/\{[\s\S]*\}/)
  if (braceMatch) candidates.push(braceMatch[0])

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && "id" in parsed && "nodes" in parsed) {
        return parsed as Record<string, unknown>
      }
    } catch { /* try next */ }
  }
  return null
}

const SYSTEM_HEADER = `You are AgentX's workflow author. The user describes a business process in
plain language; you return a valid V2 workflow JSON that implements it.

Read the node catalog below. Prefer the BPM primitives (userTask,
subProcess, signal.emit/wait, timer.boundary, gateway.parallel, rule)
when modelling processes with humans, deadlines, parallel streams, or
nested activities. Prefer the bot primitives (agent, branch, action.*)
for simple message-in → reply-out automations.`

const NODE_CATALOG = `# V2 Node catalog

## Triggers (exactly one per workflow)
- \`trigger.channel\` — inbound channel event.
    config: { "source": "whatsapp-message" | "telegram-message" | "slack-message" | "discord-message" | "gitlab-issue" | "gitlab-pipeline", "filter": { "chat"?: "*", "project"?: "noqta/web", "labels"?: ["x"] } }
- \`trigger.cron\` — scheduled.           config: { "spec": "0 9 * * *", "timezone": "Africa/Tunis" }
- \`trigger.hook\` — subscribes to any on:* hook event. config: { "event": "on:gitlab-issue" }
- \`trigger.manual\` — kicked off by CLI or API. config: {}
- \`trigger.form\` — human fills a form to start. config: { "form": FormSchema, "startableBy": "role:public" }

## Compute
- \`agent\` — run an agent with a templated prompt. Output: { reply, result (parsed RESULT: token), json?, durationMs }.
    config: { "agentId": "<id>", "prompt": "Classify {{trigger.text}} — reply on one line: RESULT: a|b|c", "resultParser": "noqta-result-token" | "json", "timeoutMinutes": 2 }
- \`transform\` — reshape upstream context.
    config: { "path": "trigger.contact.phone" }  OR  { "template": { "key": "{{trigger.text}}" } }

## Control flow
- \`branch\` — N-way switch (first match wins).
    config: { "cases": [{ "when": { "kind": "equals"|"contains"|"matches"|"exists", "params": { "path": "classify.result", "value": "ok" } }, "to": "port1" }], "default": "fallbackPort" }
  Wire with edges: { "from": "branchId", "fromPort": "port1", "to": "nextNode" }
- \`gateway.parallel\` — fan-out (one → many) or join (many → one).
    config: { "mode": "fanOut" }   — splits to every outgoing edge
    config: { "mode": "join" }     — waits until every incoming edge arrives, then fires once
- \`rule\` — DMN decision table, first matching row wins.
    config: {
      "inputs": ["{{trigger.tier}}", "{{trigger.amount}}"],
      "rules": [
        { "when": ["gold", ">100"], "to": "vip",  "output": { "route": "vip" } },
        { "when": ["*",    ">50"],  "to": "high", "output": { "route": "high" } }
      ],
      "default": { "to": "low", "output": { "route": "low" } }
    }
    Cell syntax: "*" wildcard, exact "value", ">N" "<N" ">=N" "<=N", "!=x", "/regex/".
- \`checkpoint\` — pause until a matching event.
    config: { "name": "await-x", "waitFor": { "source": "manual" }, "resumeMatch": {} }

## BPM
- \`userTask\` — assign a form to an actor or role; pauses until submission.
    config: {
      "assignTo": "actor:alice" | "role:reviewers",
      "title": "Review expense {{trigger.values.amount}}",
      "description": "…",
      "dueIn": "P2D" | "PT2H" | { "minutes": 60 },
      "form": FormSchema
    }
    Output: { submittedBy, submittedAt, values: { fieldKey: value }, action: "primary" | "secondary" }
- \`subProcess\` — spawn a child workflow; parent pauses until child reaches end.
    config: {
      "workflowId": "<other workflow id>",
      "inputMap": { "trigger": { "grantee": "{{trigger.values.name}}" } }  (or "*" for full inherit),
      "awaitCompletion": true
    }
    Output: { childRunId, status, output: <child's last bundle> }
- \`signal.emit\` — publish an event.  config: { "name": "approved", "scope": "workflow"|"global", "payload": {} }
- \`signal.wait\` — pause until matching signal arrives. config: { "name": "approved", "scope": "workflow", "match": { "grantId": "{{trigger.id}}" } }
- \`timer.boundary\` — pause for a duration. config: { "after": "PT2H" | "P1D" | 60 (minutes) }

## Actions — side-effect sinks
- \`action.send\` — post a message to any channel. config: { "channel": "telegram"|"whatsapp"|…, "chatId": "{{trigger.chatId}}", "text": "Hi {{classify.reply}}", "accountId"?: "…" }
- \`action.createIssue\` — open a GitLab issue. config: { "channel": "gitlab", "project": "noqta/web", "title": "…", "description": "…", "labels": ["x"], "assignees": ["user"] }
- \`action.setLabel\` / \`action.readLabel\` / \`action.react\` / \`action.editMessage\` / \`action.logTime\` — self-explanatory; each maps 1:1 to a channel adapter method.
- \`action.callHTTP\` — outbound HTTP.  config: { "method": "POST"|"GET"|…, "url": "https://…", "headers": {}, "body": {}, "timeoutMs": 30000 }

## Terminal
- \`end\` — completes the run. config: { "status": "completed" | "failed" | "canceled" }

## FormSchema (used by userTask + trigger.form)
{
  "title": "Review application",
  "description": "…",
  "fields": [
    { "key": "score", "label": "Score", "type": "number", "required": true, "validate": { "min": 1, "max": 10 } },
    { "key": "verdict", "label": "Verdict", "type": "select", "required": true, "options": ["approve", "reject"] },
    { "key": "notes",  "label": "Notes",   "type": "long-text" }
  ],
  "submitLabel": "Approve",
  "secondaryAction": { "key": "reject", "label": "Reject" }
}
Field types: text, long-text, number, boolean, date, select, multi-select, file.
A form with a \`secondaryAction\` and no required-unfilled fields renders as one-tap Approve/Reject buttons in chat.

## Templates
Every prompt + config value can reference \`{{nodeId.path}}\` against the run context. Examples:
  {{trigger.values.amount}}     — field from the start form
  {{classify.result}}           — parsed RESULT: token from an agent node
  {{review.values.score}}       — submitted userTask field
  {{env.GITLAB_TOKEN}}          — env var (must be listed in workflow.envAllow)

## Edges
[{ "from": "nodeId", "to": "nodeId" }, { "from": "branchId", "fromPort": "case-label", "to": "nodeId" }]
Every edge's from/to must reference an existing node. Branch + rule nodes MUST have outgoing edges whose fromPort matches a declared case/rule/default.

## Workflow shell
{
  "id": "lower-kebab-id",
  "version": 2,
  "title": "Human readable",
  "description": "optional",
  "priority": 0,
  "fanOut": false,
  "envAllow": [],
  "maxChildDepth": 5,
  "retention": { "maxRuns": 500, "maxDays": 90 },
  "nodes": [...],
  "edges": [...]
}

## Lint rules (all enforced on save)
- exactly one trigger.* node
- every edge references an existing node
- every node is reachable from the trigger
- at least one end/checkpoint/userTask/subProcess/signal.wait/timer.boundary is reachable
- branch + rule outgoing fromPort values match declared cases (or default)
- cycles are only allowed when the cycle crosses an agent/checkpoint/userTask/subProcess/signal.wait/timer.boundary`

const RESPONSE_RULES = `# Your reply

Respond in ONE of two ways:

1. **Clarification**: if the user's request is ambiguous, ask exactly ONE short follow-up question. No JSON.

2. **Workflow**: if you have enough to produce a workflow, reply with:
   - 1–3 short lines explaining what you built
   - a \`\`\`json code block containing the complete, valid V2 workflow
   - (no prose after the JSON block)

Only reference agent ids, actor ids, role ids, and channel names that
appear in the Environment section above. If the user asks for an agent
that doesn't exist, tell them which agent to register first. Never
invent workflowIds for subProcess that aren't in the existing list.`