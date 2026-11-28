// --- The one agent form (#2144) ---
//
// Every place that creates or edits an agent reads its fields, labels,
// help, checks and calls from here: the Hub's Agents page (wall-agents.ts,
// a Sheet drawn as HTML strings), Settings › General's Add agent and the
// Agent pane (React, src/hub/settings), and the server's own checks
// (admin-panel.ts). So the forms and the server say the same thing.
//
// No React: the Hub page ships these functions to the browser through
// injectFns, so each is self-contained and calls only the other agm*
// functions of this file. Data is returned by functions (agmFields,
// agmLimits, agmModelGroups) for the same reason; the model lists ride on
// agmModelGroups as a property (injectFns writes it into the page).
import { seedModels } from "./conventions/seed-models"

/** The form, as the page keeps it between repaints. */
export interface AgmForm {
  name?: string; id?: string; role?: string; workspace?: string; tier?: string; model?: string
  triggers?: string; instructions?: string; publicApi?: boolean
  telegramEnv?: string; slackBotEnv?: string; slackAppEnv?: string; discordEnv?: string
  /** The owner said yes to moving this machine's one Slack or Discord bot
   *  away from the agent it answers as now. */
  moveSlack?: boolean; moveDiscord?: boolean
}
export type AgmKey = keyof AgmForm
/** Field key -> the sentence shown under that field. */
export type AgmErrors = Partial<Record<AgmKey, string>>
/** Which agent this machine's one Slack bot and one Discord bot answer as
 *  now ("" for none), from GET /api/admin/state. */
export interface AgmBound { slack?: string; discord?: string }
/** One call to make, in order, with what it does in words. */
export interface AgmStep { method: "POST" | "PATCH" | "DELETE"; path: string; body: Record<string, unknown>; what: string }
/** The calls, or the first refusal (`error`) with every field's (`errors`). */
export interface AgmPlan { id: string; steps: AgmStep[]; error: string; errors?: AgmErrors }
/** An agent as GET /api/admin/state sends it (the fields used here). */
export interface AgmAgent { id: string; name?: string; tier?: string; model?: string; mentions?: string[]; workspace?: string; access?: string; systemPrompt?: string }

/** One field: its label, one line of help, an example, and where it sits:
 *  basic fields first, Channels and Advanced folded. `only` "new": the
 *  field is set when the agent is created, not edited. */
export interface AgmFieldDef { key: AgmKey; label: string; help: string; ph: string; group: "basic" | "channels" | "advanced"; only?: "new" }

export function agmFields(): AgmFieldDef[] {
  return [
    { key: "name", label: "Display name", help: "Shown on the Hub, the org chart and in chats", ph: "Sales Desk", group: "basic" },
    { key: "id", label: "Agent id", help: "From the name if empty: lowercase letters, digits, - and _", ph: "sales", group: "basic", only: "new" },
    { key: "role", label: "Role", help: "Its title on the org chart", ph: "Sales lead", group: "basic" },
    { key: "workspace", label: "Workspace", help: "The folder it works in. Empty: agents/<id> in the daemon's folder", ph: "~/work/sales", group: "basic", only: "new" },
    { key: "tier", label: "AI engine", help: "", ph: "", group: "basic" },
    { key: "model", label: "Model", help: "Empty: the engine's default", ph: "claude-sonnet-5-5", group: "basic" },
    { key: "instructions", label: "Instructions", help: "Up to 4,000 characters. Longer ones go in its CLAUDE.md", ph: "You answer pricing questions.", group: "basic" },
    { key: "triggers", label: "Wake words", help: "The words that call it in a shared chat. Empty: @<id>", ph: "@sales, sales", group: "advanced" },
    { key: "publicApi", label: "Answers on the public API", help: "A token with agent:<id> scope can reach it", ph: "", group: "advanced" },
    { key: "telegramEnv", label: "Telegram bot token", help: "The name of the variable that holds it, not the token", ph: "SALES_TG_TOKEN", group: "channels", only: "new" },
    { key: "discordEnv", label: "Discord bot token", help: "The name of the variable that holds it", ph: "DISCORD_BOT_TOKEN", group: "channels", only: "new" },
    { key: "slackBotEnv", label: "Slack bot token", help: "The name of the variable that holds it", ph: "SLACK_BOT_TOKEN", group: "channels", only: "new" },
    { key: "slackAppEnv", label: "Slack app token", help: "The name of the variable that holds it", ph: "SLACK_APP_TOKEN", group: "channels", only: "new" },
  ]
}

/** A field's definition by key. */
export function agmField(key: AgmKey): AgmFieldDef {
  return agmFields().find((f) => f.key === key) || { key, label: String(key), help: "", ph: "", group: "basic" }
}

/** The longest instructions (systemPrompt) saved, on create and on edit alike. */
export function agmLimits(): { instructions: number } {
  return { instructions: 4000 }
}
export const INSTRUCTIONS_MAX = agmLimits().instructions

/** The models the pickers offer, by engine. A typed name not in the list is
 *  kept too, so a new model needs no release. */
export function agmModelGroups(): Array<{ tier: string; models: string[] }> {
  return agmModelGroups.groups.map((g) => ({ tier: g.tier, models: g.models.slice() }))
}
/** From the seed lists (conventions/seed-models.ts), the one place models are named. */
agmModelGroups.groups = (["claude-code", "codex-cli"] as const).map((tier) => ({ tier: tier as string, models: seedModels(tier).map((m) => m.id) }))
export const MODEL_GROUPS: readonly { tier: string; models: readonly string[] }[] = agmModelGroups()

/** The model field's help: a typed name that is not listed is kept, and
 *  checked on the agent's first run. */
export function agmModelHelp(model: unknown): string {
  const m = String(model == null ? "" : model).trim()
  if (!m) return agmField("model").help
  return agmModelGroups().some((g) => g.models.indexOf(m) >= 0) ? "" : "Not in the list: checked on first run"
}

/** An agent id from a name: lowercase letters, digits, - and _. */
export function agmSlug(name: unknown): string {
  return String(name == null ? "" : name).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").replace(/-{2,}/g, "-").slice(0, 40)
}

/** What is wrong with one field's value, or "". The server checks a create
 *  and an edit with the same sentences (admin-panel.ts). */
export function agmFieldProblem(key: AgmKey, value: unknown): string {
  const v = String(value == null ? "" : value).trim()
  if (key === "name") return v ? "" : "Give the agent a name."
  if (key === "id") return /^[a-z0-9][a-z0-9_-]*$/.test(v) ? "" : "The agent id takes lowercase letters, digits, - and _."
  if (key === "instructions") {
    const max = agmLimits().instructions
    return v.length > max ? "The instructions take up to " + max + " characters. Put longer ones in the agent's CLAUDE.md." : ""
  }
  if (key === "telegramEnv" || key === "discordEnv" || key === "slackBotEnv" || key === "slackAppEnv") {
    const label = agmField(key).label
    return !v || /^[A-Z][A-Z0-9_]*$/.test(v) ? "" : label + ": write the environment variable's name in capitals, such as " + label.replace(/ token$/, "").toUpperCase().replace(/ /g, "_") + "_TOKEN."
  }
  return ""
}

/** Every field's problem in a new agent's form. Slack and Discord have one
 *  bot per machine: taking it from the agent in `bound` needs the owner's
 *  yes (moveSlack, moveDiscord). */
export function agmCreateErrors(f: AgmForm, bound?: AgmBound): AgmErrors {
  const t = (v: unknown) => String(v == null ? "" : v).trim()
  const id = t(f.id) || agmSlug(f.name)
  const out: AgmErrors = {}
  const keys: AgmKey[] = ["name", "id", "instructions", "telegramEnv", "discordEnv", "slackBotEnv", "slackAppEnv"]
  for (const k of keys) {
    const p = agmFieldProblem(k, k === "id" ? id : f[k])
    if (p && !(k === "id" && out.name && !t(f.id))) out[k] = p
  }
  if (!out.slackBotEnv && !out.slackAppEnv && !!t(f.slackBotEnv) !== !!t(f.slackAppEnv)) out[t(f.slackBotEnv) ? "slackAppEnv" : "slackBotEnv"] = "Slack needs both token names: the bot token and the app token."
  const other = (ch: "slack" | "discord") => { const b = t(bound && bound[ch]); return b && b !== id ? b : "" }
  if (t(f.slackBotEnv) && other("slack") && !f.moveSlack) out.moveSlack = "Slack's bot answers as @" + other("slack") + " now. Tick \"Move the Slack bot\" to make it answer as @" + id + ", or leave the Slack fields empty."
  if (t(f.discordEnv) && other("discord") && !f.moveDiscord) out.moveDiscord = "Discord's bot answers as @" + other("discord") + " now. Tick \"Move the Discord bot\" to make it answer as @" + id + ", or leave the Discord field empty."
  return out
}

/** The first problem, in form order, so a one-line note can say it. */
export function agmFirstError(errors: AgmErrors): string {
  const order: AgmKey[] = ["name", "id", "role", "workspace", "tier", "model", "instructions", "triggers", "publicApi", "telegramEnv", "discordEnv", "moveDiscord", "slackBotEnv", "slackAppEnv", "moveSlack"]
  for (const k of order) if (errors[k]) return errors[k] as string
  return ""
}

/** The calls that create an agent from the form: the agent first (with its
 *  role and workspace), then its public API access and each channel. */
export function agmCreateSteps(f: AgmForm, bound?: AgmBound): AgmPlan {
  const P = "/api/admin/wall/settings"
  const t = (v: unknown) => String(v == null ? "" : v).trim()
  const name = t(f.name), id = t(f.id) || agmSlug(name)
  const errors = agmCreateErrors(f, bound)
  const error = agmFirstError(errors)
  if (error) return { id, steps: [], error, errors }
  const other = (ch: "slack" | "discord") => { const b = t(bound && bound[ch]); return b && b !== id ? b : "" }
  const body: Record<string, unknown> = { id, name, triggerWords: t(f.triggers) || "@" + id, tier: t(f.tier) || "claude-code" }
  if (t(f.model)) body.model = t(f.model)
  if (t(f.instructions)) body.personality = t(f.instructions)
  if (t(f.role)) body.role = t(f.role)
  if (t(f.workspace)) body.workspace = t(f.workspace)
  const steps: AgmStep[] = [{ method: "POST", path: P + "/agents", body, what: "the agent" }]
  if (f.publicApi) steps.push({ method: "POST", path: P + "/agents/access", body: { id, access: "public" }, what: "public API access" })
  if (t(f.telegramEnv)) steps.push({ method: "POST", path: P + "/channels/telegram", body: { id, agentBinding: id, botTokenEnv: t(f.telegramEnv) }, what: "Telegram" })
  if (t(f.slackBotEnv)) {
    const sb: Record<string, unknown> = { botTokenEnv: t(f.slackBotEnv), appTokenEnv: t(f.slackAppEnv), agentBinding: id }
    if (other("slack")) sb.moveBot = true
    steps.push({ method: "POST", path: P + "/channels/slack", body: sb, what: "Slack" })
  }
  if (t(f.discordEnv)) {
    const db: Record<string, unknown> = { tokenEnv: t(f.discordEnv), agentBinding: id }
    if (other("discord")) db.moveBot = true
    steps.push({ method: "POST", path: P + "/channels/discord", body: db, what: "Discord" })
  }
  return { id, steps, error: "" }
}

/** The form for an agent that exists, filled from what is saved. */
export function agmFormOf(a: AgmAgent, role: string): AgmForm {
  return {
    name: a.name || a.id, id: a.id, role: role || "", workspace: a.workspace || "", tier: a.tier || "claude-code", model: a.model || "",
    triggers: (a.mentions || []).join(", "), instructions: a.systemPrompt || "", publicApi: a.access === "public",
  }
}

/** The calls that save an edit: only what changed. `inChart` says whether
 *  the agent is in the org chart already (its role is set, else added). */
export function agmEditSteps(a: AgmAgent, role: string, inChart: boolean, f: AgmForm): AgmPlan {
  const P = "/api/admin/wall/settings"
  const t = (v: unknown) => String(v == null ? "" : v).trim()
  const was = agmFormOf(a, role), id = a.id
  const errors: AgmErrors = {}
  const name = agmFieldProblem("name", f.name)
  if (name) errors.name = name
  if (!t(f.triggers)) errors.triggers = "Keep at least one wake word, such as @" + id + "."
  // Instructions saved longer before the limit stay as they are until changed.
  const long = t(f.instructions) !== t(was.instructions) && agmFieldProblem("instructions", f.instructions)
  if (long) errors.instructions = long
  if (t(f.role) !== t(was.role) && !t(f.role) && inChart) errors.role = "An agent in the org chart keeps a role. Remove it from the chart on the Org page."
  const error = agmFirstError(errors)
  if (error) return { id, steps: [], error, errors }
  const patch: Record<string, unknown> = {}
  if (t(f.name) !== t(was.name)) patch.name = t(f.name)
  if (t(f.tier) && t(f.tier) !== t(was.tier)) patch.tier = t(f.tier)
  if (t(f.model) !== t(was.model)) patch.model = t(f.model)
  if (t(f.triggers) !== t(was.triggers)) patch.triggerWords = t(f.triggers)
  if (t(f.instructions) !== t(was.instructions)) patch.systemPrompt = t(f.instructions)
  const steps: AgmStep[] = []
  if (Object.keys(patch).length) steps.push({ method: "PATCH", path: P + "/agents", body: { id, patch }, what: "its settings" })
  if (t(f.role) && t(f.role) !== t(was.role)) {
    steps.push({ method: "POST", path: P + "/org/chart", body: inChart ? { op: "set-role", member: "agent:" + id, role: t(f.role) } : { op: "add-member", member: "agent:" + id, role: t(f.role) }, what: "its role" })
  }
  if (!!f.publicApi !== !!was.publicApi) steps.push({ method: "POST", path: P + "/agents/access", body: { id, access: f.publicApi ? "public" : "private" }, what: "public API access" })
  return { id, steps, error: steps.length ? "" : "Nothing changed." }
}

/** Where an agent works: the folder the form names (`~/` is the home
 *  folder, a relative path is under the daemon's folder `base`), or
 *  agents/<id>. POSIX paths; the server resolves the result once more for
 *  its own platform. `custom` says the owner picked it. */
export function agmWorkspacePath(raw: unknown, id: string, base: string, home: string): { path: string; custom: boolean; relative: boolean; error: string } {
  const s = String(raw == null ? "" : raw).trim()
  const norm = (p: string) => {
    const out: string[] = []
    for (const part of p.split("/")) {
      if (!part || part === ".") continue
      if (part === "..") out.pop(); else out.push(part)
    }
    return "/" + out.join("/")
  }
  if (!s) return { path: norm(base + "/agents/" + id), custom: false, relative: false, error: "" }
  if (s.length > 500 || /[\0\r\n]/.test(s)) return { path: "", custom: true, relative: false, error: "The workspace is a folder path on one line." }
  const tilde = s === "~" || s.indexOf("~/") === 0
  if (tilde && !home) return { path: "", custom: true, relative: false, error: "No home folder is known here: write the workspace as a full path." }
  const relative = !tilde && s.charAt(0) !== "/"
  return { path: norm(tilde ? home + "/" + s.slice(1) : relative ? base + "/" + s : s), custom: true, relative, error: "" }
}
