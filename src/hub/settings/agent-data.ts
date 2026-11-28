// --- Settings › Agent and Actions: what they read, and the pure sums on it (#2101 ST2a) ---
//
// The old Settings' agent page (wall-settings-agent.client.ts) and Actions
// (wall-settings-actions.client.ts), as plain functions the panes and the
// test share. Nothing new on the server: /api/admin/state carries each
// agent's edit fields, its integrations and the actions; /api/workflows
// says which workflow runs an action (an `action.run` or poll node's
// `config.actionId`).
import { INSTRUCTIONS_MAX, MODEL_GROUPS } from "../../agents/agent-form"
import type { AdminState, StateAgent } from "./data"

export interface Integration {
  kind: string
  label: string
  enabled?: boolean
  credentials?: Record<string, string>
  credStatus?: Record<string, "set" | "unset" | "literal">
  metadata?: Record<string, string>
  oauth?: { title: string; connected?: boolean; expiresAt?: string | number; refreshes?: boolean; problems?: string[] }
}
export interface AgentConfig extends StateAgent {
  mentions?: string[]
  systemPrompt?: string
  maxConcurrent?: number
  maxExecutionMinutes?: number
  permissionMode?: string
  wikiAbsorb?: boolean
  integrations?: Integration[]
}
export interface CronRow { id: string; agent?: string; model?: string }
export interface ActionInput { name: string; type: string; required?: boolean; description?: string; defaultValue?: unknown }
export interface ActionDef {
  id: string; title: string; kind: "shell" | "http"; description?: string; inputs?: ActionInput[]; timeoutMs?: number
  command?: string; url?: string; method?: string
}
export interface TelegramAccount { id: string; botUsername?: string; agentBinding?: string }
export type AgentState = AdminState & {
  agents?: AgentConfig[]; crons?: CronRow[]; actions?: ActionDef[]; telegram?: { enabled?: boolean; accounts?: TelegramAccount[] }
}

/** The Overview's fields, in form order: key in the PATCH and the label the
 *  review dialog shows. */
export const AGENT_FIELDS = [
  ["name", "Display name"], ["triggerWords", "Wake words"], ["tier", "AI engine"], ["model", "Model"],
  ["permissionMode", "Tool permissions"], ["maxConcurrent", "Conversations at once"], ["maxExecutionMinutes", "Longest task"],
  ["access", "Answers on the public API"], ["wikiAbsorb", "In the wiki absorb"], ["systemPrompt", "Instructions"],
] as const
export type AgentField = (typeof AGENT_FIELDS)[number][0]
/** The form's values, as strings (switches are "on" / "off"). */
export type AgentDraft = Partial<Record<AgentField, string>>

/** The fields that apply only after a daemon restart, and their name in a sentence. */
const RESTART: Partial<Record<AgentField, string>> = { model: "model", permissionMode: "tool permissions" }
export const RESTART_CMD = "agentx daemon restart --when-idle"
export const PERMISSIONS = [["default", "Default"], ["plan", "Plan only"], ["bypassPermissions", "Bypass permissions"]] as const
export { INSTRUCTIONS_MAX }

export function savedValue(a: AgentConfig, k: AgentField): string {
  switch (k) {
    case "name": return a.name || ""
    case "triggerWords": return (a.mentions || []).join(", ")
    case "tier": return a.tier || "claude-code"
    case "model": return a.model || ""
    case "permissionMode": return a.permissionMode || "default"
    case "maxConcurrent": return String(a.maxConcurrent || 1)
    case "maxExecutionMinutes": return String(a.maxExecutionMinutes || 20)
    case "access": return a.access === "public" ? "on" : "off"
    case "wikiAbsorb": return a.wikiAbsorb !== false ? "on" : "off"
    case "systemPrompt": return a.systemPrompt || ""
  }
}

export const draftValue = (a: AgentConfig, d: AgentDraft, k: AgentField) => d[k] ?? savedValue(a, k)
const same = (k: AgentField, x: string, y: string) => (k === "systemPrompt" ? x === y : x.trim() === y.trim())
export const isChanged = (a: AgentConfig, d: AgentDraft, k: AgentField) => !same(k, draftValue(a, d, k), savedValue(a, k))
export const changedFields = (a: AgentConfig, d: AgentDraft): AgentField[] => AGENT_FIELDS.map(([k]) => k).filter((k) => isChanged(a, d, k))
export const fieldLabel = (k: AgentField) => AGENT_FIELDS.find(([f]) => f === k)![1]

/** A value as a person reads it. */
export function showValue(k: AgentField, v: string, engine: (tier: string) => string): string {
  if (k === "tier") return engine(v)
  if (k === "model") return v.trim() || "the engine's default"
  if (k === "permissionMode") return PERMISSIONS.find(([p]) => p === v)?.[1] ?? v
  if (k === "access" || k === "wikiAbsorb") return v === "on" ? "On" : "Off"
  if (k === "maxExecutionMinutes") return v.trim() + " minutes"
  if (k === "systemPrompt") return v.length === 1 ? "1 character" : `${v.length} characters`
  return v.trim() || "(empty)"
}

/** "model and tool permissions": what among the changes needs a restart. */
export function restartWords(changes: AgentField[]): string {
  const w = changes.map((k) => RESTART[k]).filter((x): x is string => !!x)
  return w.join(" and ")
}

/** The one PATCH the old Settings sends for the whole form. */
export function agentPatch(a: AgentConfig, d: AgentDraft) {
  const v = (k: AgentField) => draftValue(a, d, k)
  return {
    name: v("name").trim(), tier: v("tier"), model: v("model").trim(), triggerWords: v("triggerWords").trim(), systemPrompt: v("systemPrompt"),
    maxConcurrent: parseInt(v("maxConcurrent"), 10) || undefined, maxExecutionMinutes: parseInt(v("maxExecutionMinutes"), 10) || undefined,
    permissionMode: v("permissionMode"), access: v("access") === "on" ? "public" : "private", wikiAbsorb: v("wikiAbsorb") === "on",
  }
}

/** What else a model or engine change moves: the agent's recurring jobs
 *  that follow its model, and its spend against its cap. */
export function alsoLines(a: AgentConfig, changes: AgentField[], crons: CronRow[] | undefined, budget: { spentUsd?: number; capUsd?: number } | null | undefined): string[] {
  const out: string[] = []
  const name = a.name || a.id
  if (changes.includes("model") || changes.includes("tier")) {
    const jobs = (crons ?? []).filter((c) => c.agent === a.id)
    const follow = jobs.filter((c) => !c.model).length
    const own = jobs.length - follow
    out.push(!jobs.length ? `No recurring job runs as ${name}.`
      : !own ? `${follow === 1 ? "Its recurring job follows" : `Its ${follow} recurring jobs follow`} the agent's model and ${follow === 1 ? "changes" : "change"} too.`
      : !follow ? `${own === 1 ? "Its recurring job names its own model" : `Its ${own} recurring jobs name their own model`} and keep${own === 1 ? "s" : ""} it.`
      : `${follow} of its recurring jobs follow the agent's model and change too; ${own} keep their own.`)
    if (budget === undefined) out.push("Spend may change. Its cap could not be read.")
    else out.push(budget?.capUsd ? `It has spent ${money(budget.spentUsd)} of its ${money(budget.capUsd)} cap this month.` : `It has spent ${money(budget?.spentUsd)} this month, with no cap.`)
  }
  const r = restartWords(changes)
  out.push(r ? `The new ${r} applies after a daemon restart.` : "It applies from its next run.")
  return out
}

export function money(n?: number): string {
  const v = Number(n) || 0
  return "$" + (v >= 100 ? String(Math.round(v)) : v.toFixed(2))
}

/** The models the picker offers, by engine, from the CLI catalog's seed
 *  lists (#2349). A typed name not in the list is offered too, so a new
 *  model needs no release. */
/** The pickers' models: the one agent form's list (src/agents/agent-form.ts). */
export { MODEL_GROUPS }

/** The engine a listed model belongs to; undefined for one typed by hand. */
export function modelTier(model: string): string | undefined {
  return MODEL_GROUPS.find((g) => g.models.includes(model))?.tier
}

/** Which workflows run each action, from /api/workflows. */
export function actionUsers(workflows: { id: string; name?: string; nodes?: { type?: string; config?: Record<string, unknown> }[] }[] | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const w of workflows ?? []) {
    for (const n of w.nodes ?? []) {
      const id = n.config?.actionId
      if (typeof id !== "string") continue
      const list = out.get(id) ?? []
      if (!list.includes(w.id)) list.push(w.id)
      out.set(id, list)
    }
  }
  return out
}

/** "version:string!, dryRun:boolean" → inputs, as the old form reads them. */
export function parseInputs(csv: string): ActionInput[] {
  return csv.split(",").map((s) => s.trim()).filter(Boolean).map((part) => {
    const required = part.endsWith("!")
    const clean = required ? part.slice(0, -1) : part
    const at = clean.indexOf(":")
    return { name: (at >= 0 ? clean.slice(0, at) : clean).trim(), type: (at >= 0 ? clean.slice(at + 1) : "string").trim() || "string", required }
  })
}
export const inputsText = (inputs: ActionInput[] | undefined) => (inputs ?? []).map((i) => `${i.name}:${i.type}${i.required ? "!" : ""}`).join(", ")
