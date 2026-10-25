import { z } from "zod"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, relative, resolve, sep } from "path"
import { isCronExpression } from "@/daemon/config"
import { autonomyLevelSchema } from "@/guard/autonomy"
import { installedSkills, skillHome } from "@/agents/conventions"
import { DEFAULT_SCHEDULE_TIMEZONE } from "@/crons/schedule-ops"

// --- Team packages (#1164) ---
//
// A team is a set of agents that already does one job: their prompts and
// skills, the schedules that make them work without being asked, and the
// channels they expect to be reached on. One JSON file holds all of it, so
// the same format serves the teams shipped with AgentX, `team export` and
// `team import`.
//
// What a package never holds: tokens, chat ids, phone numbers, contact
// routes, webhook secrets, notify destinations, fire tokens or shell
// commands. The schemas are strict, so a file that carries any other key is
// refused rather than half-read, and every string is scanned for things
// that look like credentials before a package is written or installed.

export const TEAM_FORMAT = "agentx-team/1"

const ID = /^[a-z0-9][a-z0-9-]*$/
const idSchema = z.string().regex(ID, "use lowercase letters, numbers and hyphens")

const TIERS = ["claude-code", "codex-cli", "opencode", "sdk", "orchestrator"] as const

/** Largest skill file a package carries; skills are instructions, not data. */
const MAX_SKILL_FILE_BYTES = 256 * 1024

/** A skill's files by path inside the skill folder; `SKILL.md` is required. */
const skillFilesSchema = z.record(z.string(), z.string().max(MAX_SKILL_FILE_BYTES))
  .refine((files) => "SKILL.md" in files, { message: "a skill needs a SKILL.md" })
  .refine((files) => Object.keys(files).every(safeRelativePath), { message: "skill file paths must stay inside the skill folder" })

const teamAgentSchema = z.object({
  name: z.string().min(1),
  /** Runtime the team was built on. `team add --tier` overrides it. */
  tier: z.enum(TIERS).optional(),
  /** Kept only while the agent stays on `tier`: a model id is per runtime. */
  model: z.string().optional(),
  systemPrompt: z.string().default(""),
  mentions: z.array(z.string()).default([]),
  intents: z.array(z.string()).default([]),
  maxConcurrent: z.number().int().min(1).optional(),
  maxExecutionMinutes: z.number().int().min(1).max(240).optional(),
  skills: z.record(idSchema, skillFilesSchema).default({}),
}).strict()

const teamScheduleSchema = z.object({
  agent: idSchema,
  schedule: z.string().refine(isCronExpression, { message: "not a 5-field cron expression" }),
  /** Unset: the installing machine's time zone. */
  timezone: z.string().optional(),
  prompt: z.string().trim().min(1),
  timeout: z.number().int().min(1).optional(),
  enabled: z.boolean().default(true),
  maxOutputTokens: z.number().int().min(50).max(8000).optional(),
  taskType: z.string().trim().min(1).max(64).optional(),
  autonomy: autonomyLevelSchema.optional(),
  onError: z.array(z.enum(["log", "notify", "disable"])).optional(),
  /** Send each run's answer to the owner. Where it goes is never in the
   *  package: install points it at `notifications.destination` (the chat
   *  `connect telegram` captures), or leaves it waiting for one. */
  deliver: z.boolean().default(true),
  /** Flag answer lines that state a fact without a source link (#1288). */
  requireSources: z.boolean().optional(),
}).strict()

export const TEAM_CHANNEL_KINDS = ["telegram", "whatsapp", "gitlab", "github"] as const
export type TeamChannelKind = typeof TEAM_CHANNEL_KINDS[number]

const teamChannelSchema = z.object({
  kind: z.enum(TEAM_CHANNEL_KINDS),
  agent: idSchema,
  /** One line on what the channel is for, shown after install. */
  why: z.string().optional(),
}).strict()

export const teamPackageSchema = z.object({
  format: z.literal(TEAM_FORMAT),
  name: idSchema,
  title: z.string().min(1),
  /** The one-line result the team delivers, in the owner's words. */
  result: z.string().min(1),
  description: z.string().optional(),
  agents: z.record(idSchema, teamAgentSchema)
    .refine((a) => Object.keys(a).length > 0, { message: "a team needs at least one agent" }),
  schedules: z.record(idSchema, teamScheduleSchema).default({}),
  channels: z.array(teamChannelSchema).default([]),
}).strict().superRefine((pkg, ctx) => {
  for (const [id, s] of Object.entries(pkg.schedules)) {
    if (!pkg.agents[s.agent]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schedules", id, "agent"], message: `"${s.agent}" is not an agent of this team` })
  }
  pkg.channels.forEach((c, i) => {
    if (!pkg.agents[c.agent]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["channels", i, "agent"], message: `"${c.agent}" is not an agent of this team` })
  })
})

export type TeamPackage = z.infer<typeof teamPackageSchema>
export type TeamPackageInput = z.input<typeof teamPackageSchema>

function safeRelativePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || /^[a-zA-Z]:/.test(p)) return false
  return p.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}

/** Parse and check a package, secrets included. Throws with every problem listed. */
export function parseTeamPackage(raw: unknown): TeamPackage {
  const parsed = teamPackageSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n")
    throw new Error(`Not a valid team package:\n${issues}`)
  }
  const secrets = findSecrets(parsed.data)
  if (secrets.length) throw new Error(`The team package contains what looks like a secret:\n${secrets.map((s) => `  ${s}`).join("\n")}`)
  return parsed.data
}

// --- Secrets ---

const SECRET_PATTERNS: { what: string; re: RegExp }[] = [
  { what: "a GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { what: "a GitHub token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { what: "a GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { what: "an Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { what: "an API key", re: /\bsk-[A-Za-z0-9_-]{32,}/ },
  { what: "a Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { what: "a Telegram bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { what: "an AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { what: "a private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

/** Where in `value` something looks like a credential, as `path: what`. */
export function findSecrets(value: unknown, path: string[] = []): string[] {
  if (typeof value === "string") {
    return SECRET_PATTERNS.filter((p) => p.re.test(value)).map((p) => `${path.join(".") || "<root>"}: looks like ${p.what}`)
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, [...path, String(i)]))
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [...findSecrets(k, [...path, "<key>"]), ...findSecrets(v, [...path, k])])
  }
  return []
}

// --- Install ---

export interface InstallOptions {
  /** Folder the agents' workspaces go under, one folder per agent id. */
  workspaceRoot: string
  /** Runtime for every agent of the team. Unset: the package's, else claude-code. */
  tier?: typeof TIERS[number]
  /** providers.<name> for every agent of the team (sdk/orchestrator). Unset: the engine's default. */
  provider?: string
  /** Time zone for schedules that do not name one. Unset: this machine's. */
  timezone?: string
  /** Accept workspace folders that already exist (never another agent's).
   *  Files already in them are still never overwritten by the team's skills. */
  force?: boolean
}

export interface NotifyTarget { channel: string; chatId: string; accountId?: string }

export interface InstallPlan {
  agents: { id: string; workspace: string; tier: string; skills: string[] }[]
  schedules: string[]
  /** The channels to connect by hand: the one step `team add` leaves. */
  channels: { kind: TeamChannelKind; agent: string; why?: string; step: string }[]
  /** Schedules whose answers go to the owner, and where. `to` unset: they
   *  wait for a destination (`connect telegram`, or `team notify`). */
  delivery: { schedules: string[]; to?: NotifyTarget }
}

/**
 * What stops `pkg` from installing into `config`: agent and schedule ids
 * already taken, a team of the same name, and workspace folders that already exist or overlap
 * another agent's. An existing folder is accepted with `force`; another
 * agent's workspace never is.
 */
export function teamConflicts(config: any, pkg: TeamPackage, opts?: Pick<InstallOptions, "workspaceRoot" | "force">): string[] {
  const problems = [
    ...Object.keys(pkg.agents).filter((id) => config.agents?.[id]).map((id) => `agent "${id}"`),
    ...Object.keys(pkg.schedules).filter((id) => config.crons?.[id]).map((id) => `schedule "${id}"`),
  ]
  // Two installs under one tag would be listed and exported as one team.
  const members = teamMembers(config, pkg.name)
  if (members.length) problems.push(`team "${pkg.name}" (agents ${members.join(", ")})`)
  if (!opts) return problems
  const owners = new Map<string, string>()
  for (const [id, a] of Object.entries(config.agents || {}) as [string, any][]) {
    if (typeof a?.workspace === "string") owners.set(resolve(a.workspace), id)
  }
  for (const id of Object.keys(pkg.agents)) {
    const workspace = resolve(opts.workspaceRoot, id)
    // The same folder, or one inside the other: either agent would edit the other's files.
    const owner = [...owners].find(([w]) => w === workspace || workspace.startsWith(w + sep) || w.startsWith(workspace + sep))?.[1]
    if (owner) problems.push(`folder ${workspace} (overlaps the workspace of agent "${owner}")`)
    else if (!opts.force && existsSync(workspace)) problems.push(`folder ${workspace} (already exists; --force uses it without overwriting its files)`)
  }
  return problems
}

/**
 * Add `pkg`'s agents and schedules to `config`, in place. Every agent is
 * tagged `team: <name>` so the team can be listed and exported again.
 * Channels are not written: each needs a token or a pairing, which is the
 * step left to the owner, so the plan says how to do it. Throws when an id
 * is taken, before changing anything.
 */
export function applyTeam(config: any, pkg: TeamPackage, opts: InstallOptions): InstallPlan {
  const taken = teamConflicts(config, pkg, opts)
  if (taken.length) throw new Error(`Already in this install: ${taken.join(", ")}. Remove them first, or edit the package's ids.`)

  const timezone = opts.timezone ?? DEFAULT_SCHEDULE_TIMEZONE
  const dest = ownerDestination(config)
  const plan: InstallPlan = { agents: [], schedules: [], channels: [], delivery: { schedules: [], to: dest } }
  config.agents = config.agents || {}
  config.crons = config.crons || {}

  for (const [id, a] of Object.entries(pkg.agents)) {
    const tier = opts.tier ?? a.tier ?? "claude-code"
    const workspace = resolve(opts.workspaceRoot, id)
    const def: Record<string, unknown> = {
      name: a.name,
      workspace,
      tier,
      team: pkg.name,
      mentions: a.mentions,
      systemPrompt: a.systemPrompt,
    }
    // A model id belongs to one runtime: keep it only on that runtime.
    if (a.model && tier === (a.tier ?? "claude-code")) def.model = a.model
    if (opts.provider) def.provider = opts.provider
    if (a.intents.length) def.intents = a.intents
    if (a.maxConcurrent !== undefined) def.maxConcurrent = a.maxConcurrent
    if (a.maxExecutionMinutes !== undefined) def.maxExecutionMinutes = a.maxExecutionMinutes
    config.agents[id] = def
    plan.agents.push({ id, workspace, tier, skills: Object.keys(a.skills) })
  }

  // Schedules carry no model: a cron runs on its agent's runtime and model.
  for (const [id, s] of Object.entries(pkg.schedules)) {
    const job: Record<string, unknown> = {
      enabled: s.enabled,
      schedule: s.schedule,
      timezone: s.timezone ?? timezone,
      agent: s.agent,
      prompt: s.prompt,
      timeout: s.timeout ?? 600,
      onError: s.onError ?? ["log"],
    }
    if (s.maxOutputTokens !== undefined) job.maxOutputTokens = s.maxOutputTokens
    if (s.taskType) job.taskType = s.taskType
    if (s.autonomy) job.autonomy = s.autonomy
    if (s.requireSources) job.requireSources = true
    if (s.deliver) {
      // `deliverResult: true` with no `notify` marks a schedule that waits
      // for a destination; fillPendingDelivery completes it.
      job.deliverResult = true
      if (dest) setNotify(job, dest)
      plan.delivery.schedules.push(id)
    }
    config.crons[id] = job
    plan.schedules.push(id)
  }

  for (const c of pkg.channels) plan.channels.push({ ...c, step: connectStep(c.kind, c.agent) })
  return plan
}

/** The owner's chat (`notifications.destination`), when one is set. */
export function ownerDestination(config: any): NotifyTarget | undefined {
  const d = config.notifications?.destination
  if (!d?.channel || !d?.chatId) return undefined
  return clean({ channel: String(d.channel), chatId: String(d.chatId), accountId: d.accountId })
}

function setNotify(job: Record<string, any>, to: NotifyTarget): void {
  job.notify = { ...to }
  const onError: string[] = Array.isArray(job.onError) ? job.onError : job.onError ? [job.onError] : ["log"]
  job.onError = onError.includes("notify") ? onError : [...onError, "notify"]
}

/**
 * Point schedules that wait for a destination (`deliverResult: true`, no
 * `notify`) at `to`, in place. Without `ids`, only schedules of agents that
 * belong to a team: a hand-written cron of that shape stays as it is. With
 * `ids`, exactly those schedules, and with `replace`, also ones that already
 * have a destination. Returns the ids set.
 */
export function fillPendingDelivery(config: any, to: NotifyTarget, opts: { ids?: string[]; replace?: boolean } = {}): string[] {
  const set: string[] = []
  for (const [id, job] of Object.entries(config.crons || {}) as [string, any][]) {
    if (!job || job.deliverResult !== true || job.command) continue
    if (opts.ids ? !opts.ids.includes(id) : !config.agents?.[job.agent]?.team) continue
    if (job.notify && !opts.replace) continue
    setNotify(job, to)
    set.push(id)
  }
  return set
}

/** The command that connects `kind` to `agent`. */
export function connectStep(kind: TeamChannelKind, agent: string): string {
  switch (kind) {
    case "telegram": return `agentx connect telegram --agent ${agent}`
    case "whatsapp": return `agentx connect whatsapp --agent ${agent}`
    case "gitlab": return `agentx channel add   (choose GitLab, route your project to ${agent})`
    case "github": return `set channels.github, with a route to ${agent} (see docs: Connect GitHub)`
  }
}

/**
 * True when `target` or any folder between `root` and it is a symlink,
 * dangling ones included. `root` itself may be one: that is the user's choice.
 */
function linkOnPath(root: string, target: string): boolean {
  let p = root
  for (const part of relative(root, target).split(sep)) {
    p = join(p, part)
    try {
      if (lstatSync(p).isSymbolicLink()) return true
    } catch {
      return false // nothing there yet, so nothing below it either
    }
  }
  return false
}

/**
 * Write each agent's skills where its runtime reads them. A file that is
 * already there is kept, never overwritten, and nothing is written through a
 * symlink (it could point outside the workspace). Returns the folders
 * written to and the files kept.
 */
export function writeTeamSkills(pkg: TeamPackage, plan: InstallPlan): { written: string[]; kept: string[] } {
  const written: string[] = []
  const kept: string[] = []
  for (const a of plan.agents) {
    const skills = pkg.agents[a.id].skills
    if (!Object.keys(skills).length) continue
    const home = skillHome(a.tier, a.workspace)
    if (!home) continue
    for (const [name, files] of Object.entries(skills)) {
      const dir = resolve(home, name)
      for (const [rel, content] of Object.entries(files)) {
        const target = resolve(dir, rel)
        if (!target.startsWith(dir + sep)) continue // parse already refused this; belt and braces
        if (existsSync(target) || linkOnPath(a.workspace, target)) { kept.push(target); continue }
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content, { flag: "wx" })
      }
      written.push(dir)
    }
  }
  return { written, kept }
}

// --- Export ---

/** Skills AgentX installs on every agent itself; a package need not carry them. */
const BUILT_IN_SKILLS = new Set(["wiki"])

export interface ExportOptions {
  /** Agents to export. Unset: the agents tagged `team: <name>`. */
  agents?: string[]
  title?: string
  result?: string
  description?: string
  /** Channels the team expects even where they are not connected yet, such
   *  as a shipped team's. Kept for the exported agents only. */
  expectedChannels?: { kind: TeamChannelKind; agent: string; why?: string }[]
}

/** Agent ids of `team` in `config`. */
export function teamMembers(config: any, team: string): string[] {
  return Object.entries(config.agents || {}).filter(([, a]: any) => a?.team === team).map(([id]) => id).sort()
}

/**
 * Build a package from what is installed: the team's agents, their skills,
 * the schedules that run on them and the channels they are bound to. Only
 * the keys below are copied, so tokens, chat ids, contact routes, notify
 * destinations, fire tokens and commands never leave the install. Throws
 * when a copied string still looks like a secret (a token pasted into a
 * prompt), naming where.
 */
export function buildTeamPackage(config: any, name: string, opts: ExportOptions = {}): TeamPackage {
  const ids = opts.agents?.length ? opts.agents : teamMembers(config, name)
  if (!ids.length) throw new Error(`No agents belong to team "${name}". Name them with --agents.`)
  const missing = ids.filter((id) => !config.agents?.[id])
  if (missing.length) throw new Error(`Unknown agent${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`)

  const agents: Record<string, unknown> = {}
  for (const id of ids) {
    const a = config.agents[id]
    agents[id] = clean({
      name: a.name ?? id,
      tier: a.tier,
      model: a.model,
      systemPrompt: a.systemPrompt ?? "",
      mentions: a.mentions ?? [],
      intents: a.intents ?? [],
      maxConcurrent: a.maxConcurrent,
      maxExecutionMinutes: a.maxExecutionMinutes,
      skills: readSkills(a.tier, a.workspace),
    })
  }

  const schedules: Record<string, unknown> = {}
  for (const [id, c] of Object.entries(config.crons || {}) as [string, any][]) {
    // A command cron runs a shell line on this machine: not portable, and
    // the line itself may carry paths or secrets.
    if (!ids.includes(c?.agent) || c.command || !c.prompt?.trim()) continue
    // Waiting for approval is not a working schedule yet.
    if (c.approval?.action === "create") continue
    schedules[id] = clean({
      agent: c.agent,
      schedule: c.schedule,
      timezone: c.timezone,
      prompt: c.prompt,
      timeout: c.timeout,
      enabled: c.enabled ?? true,
      maxOutputTokens: c.maxOutputTokens,
      taskType: c.taskType,
      autonomy: c.autonomy,
      requireSources: c.requireSources === true ? true : undefined,
      onError: c.onError === undefined ? undefined : Array.isArray(c.onError) ? c.onError : [c.onError],
      // Whether answers go to the owner, never where.
      deliver: c.deliverResult === true || (Boolean(c.notify) && c.deliverResult !== false),
    })
  }

  const pkg = {
    format: TEAM_FORMAT,
    name,
    title: opts.title ?? name,
    result: opts.result ?? `What team "${name}" does.`,
    description: opts.description,
    agents,
    schedules,
    channels: mergeChannels(opts.expectedChannels ?? [], channelBindings(config, ids), ids),
  }
  return parseTeamPackage(clean(pkg))
}

/** `expected` first (they carry the why), then what is bound, once per kind and agent. */
function mergeChannels(
  expected: { kind: TeamChannelKind; agent: string; why?: string }[],
  bound: { kind: TeamChannelKind; agent: string }[],
  ids: string[],
): { kind: TeamChannelKind; agent: string; why?: string }[] {
  const seen = new Set<string>()
  return [...expected, ...bound].filter((c) => {
    const key = `${c.kind}\0${c.agent}`
    if (!ids.includes(c.agent) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Which channels the agents are reached on, without the routes themselves. */
function channelBindings(config: any, ids: string[]): { kind: TeamChannelKind; agent: string }[] {
  const ch = config.channels || {}
  const found = new Set<string>()
  const add = (kind: TeamChannelKind, agent: unknown) => {
    if (typeof agent === "string" && ids.includes(agent)) found.add(`${kind}\0${agent}`)
  }
  for (const acc of Object.values(ch.telegram?.accounts || {}) as any[]) add("telegram", acc?.agentBinding)
  add("whatsapp", ch.whatsapp?.defaultAgent)
  for (const r of ch.whatsapp?.routes || []) add("whatsapp", r?.agent)
  for (const r of ch.gitlab?.routes || []) add("gitlab", r?.agent)
  for (const m of ch.gitlab?.agentMappings || []) add("gitlab", m?.agentId)
  for (const r of ch.github?.routes || []) add("github", r?.agent)
  for (const m of ch.github?.agentMappings || []) add("github", m?.agentId)
  return [...found].sort().map((k) => {
    const [kind, agent] = k.split("\0")
    return { kind: kind as TeamChannelKind, agent }
  })
}

/** An agent's own skills as text files, by skill name then path. */
function readSkills(tier: string | undefined, workspace: string | undefined): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  if (!workspace) return out
  for (const { name, dir } of installedSkills(tier, workspace)) {
    if (BUILT_IN_SKILLS.has(name) || !ID.test(name)) continue
    if (lstatSync(dir).isSymbolicLink()) continue // a linked skill lives outside the workspace
    const files: Record<string, string> = {}
    for (const file of walk(dir)) {
      const buf = readFileSync(file)
      if (buf.length > MAX_SKILL_FILE_BYTES || buf.includes(0)) continue // binary or too large
      files[relative(dir, file).split(sep).join("/")] = buf.toString("utf-8")
    }
    out[name] = files
  }
  return out
}

/** Regular files under `dir`. Symlinks are skipped, never followed: a link
 *  could loop, or pull a file from outside the workspace into the package. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue
    const p = join(dir, entry)
    const st = lstatSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (st.isFile()) out.push(p)
  }
  return out
}

/** Drop undefined values, so exports carry only what is set. */
function clean<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clean) as T
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue
      out[k] = clean(x)
    }
    return out as T
  }
  return v
}
