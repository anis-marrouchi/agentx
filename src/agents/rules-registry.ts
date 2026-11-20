// --- Rules for this run, from the Rules Registry (noqta#809) ---
//
// The owner asked for "a registry of rules, so the rules are clear, per
// agent, per mesh, per run, per whatever, where these applies". The
// registry is one wiki page (a decision page owned by the PM agent) with
// one table row per rule. This module reads that table and hands a run
// only the rows whose scope fits it, as one context block.
//
// Scope cell grammar (design v2, noqta#809 n153873): one or more terms
// separated by `;`. A term is `fleet`, `team`, or `kind:value` with kind
// mesh | agent | project | run. `team` rows are about people and never
// reach a run. A row whose Scope does not parse is not sent; `rulesCheck`
// lists it with the reason.
//
// A run gets a row only when both hold:
//   Who:   "Applies to" names no agent, or names this run's agent (agent id
//          or display name, whole word, any case).
//   Where: one Scope term fits the run. When a filled "Applies to" names no
//          agent of this node, only fleet, mesh and agent terms count: the
//          name may be an agent on another node.
//
// Off unless `rules.enabled`. Pure functions here; the registry wires them.

import { createHash } from "crypto"

export type ScopeTerm =
  | { kind: "fleet" }
  | { kind: "team" }
  | { kind: "mesh"; value: string }
  | { kind: "agent"; value: string }
  | { kind: "project"; value: string }
  | { kind: "run"; value: RunKind }

export type RunKind = "workflow" | "schedule" | "daily" | "weekly"
const RUN_KINDS: RunKind[] = ["workflow", "schedule", "daily", "weekly"]

export interface RuleRow {
  id: string
  title: string
  /** The Rule cell, wikilinks and bold markers removed. */
  text: string
  scope: string
  appliesTo: string
  decided: string
  check: string
  terms: ScopeTerm[]
  /** Set when the Scope cell does not parse: the row is never sent. */
  error?: string
}

export interface RunFacts {
  agentId: string
  /** This node's `config.node.name`. */
  nodeName: string
  /** Projects the wall config puts this run in (every matching entry). */
  projects: string[]
  /** Set when the run is a step of a workflow run. */
  workflowRunId?: string
  /** Started by a schedule: a `cron:<jobId>` chat, or a workflow whose
   *  trigger is `trigger.cron`. */
  scheduled: boolean
  /** The cron spec that started it: the schedule job's, or the workflow's
   *  own `trigger.cron` spec. */
  cronSpec?: string
}

export interface AgentName { id: string; name?: string }

// --- Parsing ---

export function parseScope(cell: string): { terms: ScopeTerm[]; error?: string } {
  const raw = cell.trim()
  if (!raw) return { terms: [], error: "empty Scope" }
  if (raw.includes(",")) return { terms: [], error: `a comma in Scope "${raw}": separate terms with ";"` }
  const terms: ScopeTerm[] = []
  for (const part of raw.split(";").map((p) => p.trim())) {
    if (!part) return { terms: [], error: `an empty term in Scope "${raw}"` }
    const lower = part.toLowerCase()
    if (lower === "fleet") { terms.push({ kind: "fleet" }); continue }
    if (lower === "team") { terms.push({ kind: "team" }); continue }
    const m = part.match(/^([a-z]+)\s*:\s*(.+)$/i)
    if (!m) return { terms: [], error: `unknown term "${part}"` }
    const kind = m[1].toLowerCase()
    const value = m[2].trim()
    if (kind === "mesh" || kind === "agent" || kind === "project") {
      terms.push({ kind, value })
    } else if (kind === "run") {
      const v = value.toLowerCase() as RunKind
      if (!RUN_KINDS.includes(v)) return { terms: [], error: `unknown run kind "${value}" (use ${RUN_KINDS.join(", ")})` }
      terms.push({ kind: "run", value: v })
    } else {
      return { terms: [], error: `unknown kind "${m[1]}" in "${part}"` }
    }
  }
  return { terms }
}

function cleanCell(cell: string): string {
  return cell
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, page, label) => label || page)
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function slug(s: string): string {
  const full = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (full.length <= 48) return full
  // Cut on a whole word, so an id never ends in half a word.
  const cut = full.slice(0, 49).lastIndexOf("-")
  return full.slice(0, cut > 0 ? cut : 48)
}

/** The rule's id: the first bold `**Rn**` anywhere in the Rule cell, else a
 *  slug of its title. */
export function ruleId(ruleCell: string, title: string): string {
  const bold = ruleCell.match(/\*\*\s*(R\d+)\s*\*\*/i)
  return bold ? bold[1].toUpperCase() : slug(title) || "rule"
}

function ruleTitle(ruleCell: string): string {
  const link = ruleCell.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/)
  if (link) return (link[2] || link[1]).trim()
  const text = cleanCell(ruleCell).replace(/^R\d+\s+/i, "")
  const cut = text.search(/[:(]/)
  return (cut > 0 ? text.slice(0, cut) : text).trim().slice(0, 100)
}

function splitRow(line: string): string[] {
  // A row is `| a | b | … |`. No cell on the page holds a pipe.
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return inner.split("|").map((c) => c.trim())
}

/** Every rule row of the registry page: the first Markdown table whose
 *  header has Rule, Scope and "Applies to" columns. */
export function parseRegistry(content: string): RuleRow[] {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "")
  const lines = body.split("\n")
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|")) continue
    const head = splitRow(lines[i]).map((h) => h.toLowerCase())
    const col = (name: string) => head.findIndex((h) => h === name)
    const ruleCol = col("rule"), scopeCol = col("scope"), appliesCol = col("applies to")
    if (ruleCol < 0 || scopeCol < 0 || appliesCol < 0) continue
    if (!/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue
    const decidedCol = col("decided"), checkCol = col("check")
    const rows: RuleRow[] = []
    const seen = new Map<string, number>()
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const cells = splitRow(lines[j])
      const ruleCell = cells[ruleCol] ?? ""
      if (!ruleCell) continue
      const title = ruleTitle(ruleCell)
      let id = ruleId(ruleCell, title)
      const n = (seen.get(id) ?? 0) + 1
      seen.set(id, n)
      if (n > 1) id = `${id}-${n}`
      const scope = cells[scopeCol] ?? ""
      const parsed = parseScope(scope)
      rows.push({
        id,
        title,
        text: cleanCell(ruleCell),
        scope,
        appliesTo: cells[appliesCol] ?? "",
        decided: decidedCol >= 0 ? cleanCell(cells[decidedCol] ?? "") : "",
        check: checkCol >= 0 ? cleanCell(cells[checkCol] ?? "") : "",
        terms: parsed.terms,
        ...(parsed.error ? { error: parsed.error } : {}),
      })
    }
    return rows
  }
  return []
}

// --- Matching ---

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The agents an "Applies to" cell names, by id or display name, as whole
 *  words in any case. Other words are prose ("everyone", "Anis"). */
export function namedAgents(appliesTo: string, agents: AgentName[]): string[] {
  const text = cleanCell(appliesTo)
  const hit = (word: string | undefined) =>
    !!word && word.trim().length > 0 && new RegExp(`(?<![\\w-])${escapeRe(word.trim())}(?![\\w-])`, "i").test(text)
  return agents.filter((a) => hit(a.id) || hit(a.name)).map((a) => a.id)
}

/** "daily" when the spec fires once a day at a set hour (every day, or on
 *  set weekdays); "weekly" when it fires on one weekday; otherwise null
 *  (hourly, monthly, or not a 5-field spec). */
export function cronKind(spec: string | undefined): "daily" | "weekly" | null {
  if (!spec) return null
  const f = spec.trim().split(/\s+/)
  if (f.length !== 5) return null
  const [min, hour, dom, mon, dow] = f
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return null
  if (dom !== "*" || mon !== "*") return null
  if (dow === "*" || dow === "?") return "daily"
  if (/^([0-7]|sun|mon|tue|wed|thu|fri|sat)$/i.test(dow)) return "weekly"
  if (/^[\w,-]+$/.test(dow)) return "daily" // several weekdays, e.g. 1-5
  return null
}

export function termFits(term: ScopeTerm, run: RunFacts, named: string[]): boolean {
  switch (term.kind) {
    case "fleet": return true
    case "team": return false
    case "mesh": return term.value === run.nodeName
    case "agent": return term.value.toLowerCase() === run.agentId.toLowerCase()
    case "project": {
      const v = term.value.toLowerCase()
      return named.includes(run.agentId) || run.projects.some((p) => p.toLowerCase() === v)
    }
    case "run":
      if (term.value === "workflow") return !!run.workflowRunId
      if (term.value === "schedule") return run.scheduled
      return run.scheduled && cronKind(run.cronSpec) === term.value
  }
}

/** Scope terms that stay safe when "Applies to" names nobody on this node:
 *  fleet and mesh rows are meant for every agent where they fit, and an
 *  agent: term names its agent by id itself. */
const UNNAMED_OK = new Set<ScopeTerm["kind"]>(["fleet", "mesh", "agent"])

export function rowFits(row: RuleRow, run: RunFacts, agents: AgentName[]): boolean {
  if (row.error) return false
  const named = namedAgents(row.appliesTo, agents)
  if (named.length > 0 && !named.includes(run.agentId)) return false
  // A filled "Applies to" that names no agent of this node may name one on
  // another node (R8 "Hakim" on a node without pm-agent). Falling open would
  // send it to every run its Scope fits, so then only fleet, mesh and agent
  // terms count (#2015 review B1). An empty cell still means everyone.
  const terms = named.length === 0 && cleanCell(row.appliesTo)
    ? row.terms.filter((t) => UNNAMED_OK.has(t.kind))
    : row.terms
  return terms.some((t) => termFits(t, run, named))
}

export function rulesForRun(rows: RuleRow[], run: RunFacts, agents: AgentName[]): RuleRow[] {
  return rows.filter((r) => rowFits(r, run, agents))
}

/** The wall projects that claim a run: every matching entry, by agent,
 *  home repo, or the agent's workspace folder. */
export function wallProjectsOf(
  entries: Array<{ name: string; agents?: string[]; repos?: string[]; workspaces?: string[] }> | undefined,
  run: { agentId: string; repo?: string | null; workspace?: string | null },
): string[] {
  const out: string[] = []
  for (const e of entries ?? []) {
    const byAgent = e.agents?.includes(run.agentId)
    const byRepo = !!run.repo && e.repos?.includes(run.repo)
    const ws = run.workspace?.replace(/\/+$/, "")
    const byWs = !!ws && (e.workspaces ?? []).some((w) => {
      const base = w.replace(/\/+$/, "")
      return ws === base || ws.startsWith(base + "/")
    })
    if (byAgent || byRepo || byWs) out.push(e.name)
  }
  return out
}

// --- The block ---

export const RULES_BLOCK_HEADER = "[Rules for this run — from the Rules Registry]"
export const RULES_BLOCK_END = "[End rules]"
export const RULES_MAX_TOKENS = 1200
const CHARS_PER_TOKEN = 4

function fullLine(r: RuleRow): string {
  const decided = r.decided ? ` (decided: ${r.decided})` : ""
  const line = `- ${r.id}: ${r.text}${decided}`
  return line.length > 700 ? line.slice(0, 699) + "…" : line
}

function shortLine(r: RuleRow): string {
  return `- ${r.id}: ${r.title}`
}

/** The block for a run, fitted under `maxTokens` by the builder itself:
 *  full lines while they fit, then id + title for the rest, so every rule
 *  id is always in the block. Empty when no rule fits. */
export function buildRulesBlock(rows: RuleRow[], opts: { maxTokens?: number; page?: string } = {}): string {
  if (rows.length === 0) return ""
  const max = (opts.maxTokens ?? RULES_MAX_TOKENS) * CHARS_PER_TOKEN
  const head = [
    RULES_BLOCK_HEADER,
    `These are the rules that apply to this run${opts.page ? ` (page ${opts.page})` : ""}. Follow them. A rule not listed here does not stop work.`,
  ]
  const tail = [RULES_BLOCK_END]
  const fixed = head.join("\n").length + tail.join("\n").length + 2
  const shorts = rows.map(shortLine)
  let used = fixed + shorts.reduce((n, s) => n + s.length + 1, 0)
  const lines = [...shorts]
  for (let i = 0; i < rows.length; i++) {
    const full = fullLine(rows[i])
    const extra = full.length - shorts[i].length
    if (used + extra > max) break
    lines[i] = full
    used += extra
  }
  return [...head, ...lines, ...tail].join("\n")
}

export function rulesHash(block: string): string {
  return createHash("sha256").update(block).digest("hex").slice(0, 16)
}

// --- The check ---

export interface RulesCheck {
  sent: RuleRow[]
  people: RuleRow[]
  unparsed: RuleRow[]
}

/** How every row of the page is read: sent to runs, about people (team
 *  only), or not parsed (with its reason). */
export function rulesCheck(rows: RuleRow[]): RulesCheck {
  const unparsed = rows.filter((r) => r.error)
  const ok = rows.filter((r) => !r.error)
  const people = ok.filter((r) => r.terms.every((t) => t.kind === "team"))
  const sent = ok.filter((r) => !r.terms.every((t) => t.kind === "team"))
  return { sent, people, unparsed }
}
