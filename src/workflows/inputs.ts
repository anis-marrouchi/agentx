import type { Workflow } from "./types"

// --- Workflow input resolution for auto-match dispatch ---
//
// When workflows.matching.mode === "auto" and the matcher picks a workflow,
// the workflow's trigger.config.inputSchema declares what payload it needs
// (e.g. project, environment, host, ref). The matcher hands us a free-form
// message + chatId + agent context; we have to bridge the two.
//
// v1 strategy: deterministic only.
//   1. passthrough — copy any context fields the schema declares (message,
//      agentId, channel, chatId, senderId, senderUsername).
//   2. chatId parse — known channel composites yield typed fields:
//        "<group>/<project>:issue:<id>"            → { project, id }
//        "<group>/<project>:merge_request:<id>"    → { project, id }
//        "<group>/<project>:pull_request:<id>"     → { project, id }
//        "<group>/<project>:push:refs/heads/<ref>" → { project, ref }
//   3. schema defaults — any remaining gaps fall back to the inputSchema's
//      `default` fields.
//   4. required check — if any `required` field is still empty, signal to
//      caller (auto-runner falls back to suggest mode + agent execution).
//
// LLM-based extraction (passing the message + context through an agent
// running extract.structured) is the natural follow-on but lives in a
// separate module so this hot path stays cheap and predictable.

export interface InputSchemaProperty {
  type?: string
  description?: string
  default?: unknown
  enum?: unknown[]
}

export interface InputSchemaShape {
  type?: string
  properties?: Record<string, InputSchemaProperty>
  required?: string[]
}

export interface ResolveContext {
  chatId?: string
  message?: string
  agentId?: string
  channel?: string
  senderId?: string
  senderUsername?: string
}

export interface ResolveResult {
  inputs: Record<string, unknown>
  missing: string[]
  /** Provenance per-field so log lines can explain what filled what. */
  filledFrom: { passthrough: string[]; chatId: string[]; defaults: string[] }
}

/** Pull the inputSchema off the workflow's trigger node. Returns null when
 *  the workflow is unschematized — caller should pass the matcher bundle
 *  through unchanged. */
export function getInputSchema(wf: Workflow): InputSchemaShape | null {
  const trig = wf.nodes.find((n) => n.type.startsWith("trigger."))
  const cfg = trig?.config as { inputSchema?: InputSchemaShape } | undefined
  return cfg?.inputSchema ?? null
}

/** Best-effort extraction from chatId composites. Only fields that exist
 *  in `schema.properties` end up in the result — we don't invent inputs
 *  the workflow didn't declare. */
export function fillFromChatId(
  chatId: string | undefined,
  schema: InputSchemaShape | null,
): Record<string, unknown> {
  if (!chatId || !schema?.properties) return {}
  const m = chatId.match(/^([^:]+\/[^:]+):([^:]+):(.+)$/)
  if (!m) return {}
  const [, project, kind, rest] = m
  const out: Record<string, unknown> = {}
  if (schema.properties.project) out.project = project
  if (kind === "push") {
    const refMatch = rest.match(/^refs\/heads\/(.+)$/)
    if (refMatch && schema.properties.ref) out.ref = refMatch[1]
  } else {
    // issue / merge_request / pull_request → rest is the numeric id.
    // Architects emit the id under several names depending on platform —
    // populate whichever one(s) the workflow declared.
    const idNum = Number(rest)
    if (Number.isFinite(idNum)) {
      if (schema.properties.id) out.id = idNum
      if (schema.properties.iid) out.iid = idNum
      if (schema.properties.mrId) out.mrId = idNum
      if (schema.properties.issueId) out.issueId = idNum
      if (schema.properties.prId) out.prId = idNum
    }
  }
  return out
}

/** Fill any not-yet-set field with its inputSchema `default`. */
export function applyDefaults(
  schema: InputSchemaShape | null,
  current: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema?.properties) return current
  const out = { ...current }
  for (const [k, v] of Object.entries(schema.properties)) {
    if (out[k] === undefined && v && "default" in v) out[k] = v.default
  }
  return out
}

/** Names of required fields still missing or empty after merging. */
export function missingRequired(
  schema: InputSchemaShape | null,
  populated: Record<string, unknown>,
): string[] {
  if (!schema?.required || !Array.isArray(schema.required)) return []
  return schema.required.filter((k) => {
    const v = populated[k]
    return v === undefined || v === "" || v === null
  })
}

/** Main entry point. Merges passthrough + chatId-parse + defaults and
 *  returns the result plus any required fields still missing. */
export function resolveAutoRunInputs(wf: Workflow, ctx: ResolveContext): ResolveResult {
  const schema = getInputSchema(wf)
  if (!schema?.properties) {
    // Unschematized workflow — hand the matcher bundle through. No
    // required check applies.
    const all: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(ctx)) if (v !== undefined) all[k] = v
    return { inputs: all, missing: [], filledFrom: { passthrough: Object.keys(all), chatId: [], defaults: [] } }
  }

  const passthrough: Record<string, unknown> = {}
  for (const k of ["message", "agentId", "channel", "chatId", "senderId", "senderUsername"] as const) {
    if (schema.properties[k] && ctx[k] !== undefined) passthrough[k] = ctx[k]
  }

  const fromChat = fillFromChatId(ctx.chatId, schema)
  // chatId-derived fields are higher fidelity than passthrough message.
  let merged = { ...passthrough, ...fromChat }
  const beforeDefaults = { ...merged }
  merged = applyDefaults(schema, merged)
  const filledFromDefaults = Object.keys(merged).filter(
    (k) => beforeDefaults[k] === undefined && merged[k] !== undefined,
  )

  return {
    inputs: merged,
    missing: missingRequired(schema, merged),
    filledFrom: {
      passthrough: Object.keys(passthrough),
      chatId: Object.keys(fromChat),
      defaults: filledFromDefaults,
    },
  }
}
