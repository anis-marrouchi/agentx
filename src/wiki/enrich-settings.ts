import { DEFAULT_ENRICH_TYPES, ENRICH_SOURCES, type EnrichSettings, type EnrichSource } from "./enrich"

// Settings for the scheduled enrichment of entity pages (#820), shared by
// `agentx wiki enrich config` and the run itself, so both read and check
// `wikiEnrich` in agentx.json the same way.

export const ENRICH_CRON_ID = "wiki-enrich"

export interface WikiEnrichPatch {
  enabled?: boolean
  /** "" clears it. */
  agent?: string
  types?: string[]
  sources?: string[]
  maxPages?: number
  maxSpendUsd?: number
  maxEntriesPerPage?: number
  maxNewEvents?: number
  /** "" clears it: the agent's own model is used. */
  model?: string
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/

/** The current settings, with defaults filled in. */
export function wikiEnrichSettings(raw: any): EnrichSettings {
  const n = raw && typeof raw === "object" ? raw : {}
  const list = (v: unknown): string[] | null => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : null
  const sources = list(n.sources)?.filter((s): s is EnrichSource => (ENRICH_SOURCES as readonly string[]).includes(s))
  const int = (v: unknown, d: number) => Number.isInteger(v) ? (v as number) : d
  return {
    enabled: n.enabled === true,
    agent: typeof n.agent === "string" ? n.agent : "",
    types: list(n.types) ?? [...DEFAULT_ENRICH_TYPES],
    sources: sources ?? ["entries", "contacts"],
    maxPages: int(n.maxPages, 10),
    maxSpendUsd: typeof n.maxSpendUsd === "number" && n.maxSpendUsd >= 0 ? n.maxSpendUsd : 2,
    maxEntriesPerPage: int(n.maxEntriesPerPage, 40),
    maxNewEvents: int(n.maxNewEvents, 5),
    ...(typeof n.model === "string" && n.model.trim() ? { model: n.model.trim() } : {}),
  }
}

function wholeIn(v: unknown, lo: number, hi: number, what: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} must be a whole number from ${lo} to ${hi}`)
  return n
}

/**
 * Apply `patch` to `cfg.wikiEnrich` in place and say what changed. Throws a
 * message meant for a person when the result would not work.
 */
export function patchWikiEnrich(cfg: any, patch: WikiEnrichPatch): string {
  const cur = { ...(cfg.wikiEnrich && typeof cfg.wikiEnrich === "object" ? cfg.wikiEnrich : {}) }
  const changes: string[] = []

  if (patch.agent !== undefined) {
    const agent = String(patch.agent).trim()
    if (agent && !ID_RE.test(agent)) throw new Error(`"${agent}" is not an agent id`)
    if (agent) cur.agent = agent
    else delete cur.agent
    changes.push(agent ? `agent=${agent}` : "agent cleared")
  }
  if (patch.types !== undefined) {
    const ids = [...new Set(patch.types.map(t => String(t).trim()).filter(Boolean))]
    if (ids.length === 0) throw new Error("name at least one page type, for example person,organization")
    if (ids.includes("agent")) throw new Error("agents are not enriched: their pages are not about people or organisations")
    cur.types = ids
    changes.push(`types=${ids.join(",")}`)
  }
  if (patch.sources !== undefined) {
    const ids = [...new Set(patch.sources.map(s => String(s).trim()).filter(Boolean))]
    const bad = ids.filter(s => !(ENRICH_SOURCES as readonly string[]).includes(s))
    if (bad.length) throw new Error(`unknown source ${bad.join(", ")}; pick from ${ENRICH_SOURCES.join(", ")}`)
    cur.sources = ids
    changes.push(`sources=${ids.length ? ids.join(",") : "none"}`)
  }
  if (patch.maxPages !== undefined) { cur.maxPages = wholeIn(patch.maxPages, 1, 200, "pages per run"); changes.push(`maxPages=${cur.maxPages}`) }
  if (patch.maxEntriesPerPage !== undefined) { cur.maxEntriesPerPage = wholeIn(patch.maxEntriesPerPage, 1, 200, "messages per page"); changes.push(`maxEntriesPerPage=${cur.maxEntriesPerPage}`) }
  if (patch.maxNewEvents !== undefined) { cur.maxNewEvents = wholeIn(patch.maxNewEvents, 0, 20, "new event pages per page"); changes.push(`maxNewEvents=${cur.maxNewEvents}`) }
  if (patch.maxSpendUsd !== undefined) {
    const n = Number(patch.maxSpendUsd)
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error("spending cap must be a number of dollars from 0 to 1000 (0 means no cap)")
    cur.maxSpendUsd = n
    changes.push(`maxSpendUsd=${n}`)
  }
  if (patch.model !== undefined) {
    const model = String(patch.model).trim()
    if (model && !/^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]*$/.test(model)) throw new Error(`"${model}" is not a model name`)
    if (model) cur.model = model
    else delete cur.model
    changes.push(model ? `model=${model}` : "model cleared")
  }
  if (patch.enabled !== undefined) {
    cur.enabled = Boolean(patch.enabled)
    changes.push(cur.enabled ? "on" : "off")
  }
  if (changes.length === 0) throw new Error("nothing to update")
  if (cur.enabled && !cur.agent) throw new Error("set the agent first: the agent that runs the enrichment and owns the pages it writes")
  if (cur.agent && cfg.agents && !cfg.agents[cur.agent]) throw new Error(`no agent "${cur.agent}" on this node`)

  cfg.wikiEnrich = cur
  return `wiki enrichment updated (${changes.join(", ")})`
}

/** Add, change or remove the schedule that runs the enrichment. */
export function patchEnrichCron(cfg: any, schedule: string, cli: string, timezone?: string): string {
  const agent = cfg.wikiEnrich?.agent
  cfg.crons = cfg.crons && typeof cfg.crons === "object" ? cfg.crons : {}
  if (!schedule.trim()) {
    if (!cfg.crons[ENRICH_CRON_ID]) return "no enrichment schedule to remove"
    delete cfg.crons[ENRICH_CRON_ID]
    return `schedule ${ENRICH_CRON_ID} removed`
  }
  if (!agent) throw new Error("set the agent first (--agent)")
  if (schedule.trim().split(/\s+/).length !== 5) throw new Error(`"${schedule}" is not a five-field cron schedule, for example "0 3 * * *"`)
  const prev = cfg.crons[ENRICH_CRON_ID] ?? {}
  cfg.crons[ENRICH_CRON_ID] = {
    ...prev,
    enabled: true,
    schedule: schedule.trim(),
    timezone: timezone ?? prev.timezone ?? "UTC",
    agent,
    command: `node ${cli} wiki enrich run`,
    // A run reads each page and asks the agent once per page.
    timeout: prev.timeout ?? 3600,
  }
  return `schedule ${ENRICH_CRON_ID} runs "${schedule.trim()}" as ${agent}`
}
