import { readHold } from "@/notify/hold"
import type { FocusState } from "@/notify/focus"
import type { SituationsConfig } from "./config"
import type { SituationRow, SituationStore } from "./store"
import { oneLine, quoted, situationTemplate } from "./templates"

// --- The [Situation] prompt layer (#1892, phase 2) ---
//
// One short line that tells the agent which situation its chat is in and
// what the phase asks of it. Read live from the chat's record when the
// turn is built; the owner's busy state is read live from its own home
// (notify/hold.ts), never copied onto the record.
//
// Per-turn cost rule: like the other new layers, it goes on FRESH sessions
// only. The one exception is the end of a talk (`ending`, `ended`): a
// resumed session would otherwise never learn that the talk is closing,
// which is the moment the line is for. That exception is bounded: only
// within RESUMED_WINDOW_MS of the phase change (`ended` has no max age,
// and an "ok" does not reopen it). It is one line, about 30 tokens.
//
// Privacy: the owner's busy state is named generically. The hold's own
// reason ("in a call with …", a macOS Focus or sleep assertion) never
// goes into the prompt: the chat may be a customer's.
//
// Only in `active` mode: shadow mode changes nothing, so the agent is not
// told either. Any error gives no layer (fail open): the turn runs as
// before.

export interface SituationContextSource {
  store: Pick<SituationStore, "get">
  settings: () => SituationsConfig
  /** The owner's hold (Focus, a call). Defaults to notify/hold.ts. */
  hold?: () => FocusState
}

let source: SituationContextSource | null = null

/** Attach the record (daemon start). Null detaches it. */
export function setSituationContextSource(s: SituationContextSource | null): void {
  source = s
}

const WHY_MAX = 120
const PURPOSE_MAX = 80
/** Phase 6, `situations.templates.agentFill`: a fresh plain conversation
 *  is told once that its agent may name the talk. */
export const AGENT_FILL_LINE = "If this chat is a meeting with an outside party, a hand-off or a change on a live system, name it once with the agentx_situation tool."
/** A resumed session gets the line only this long after the phase changed
 *  to `ending` or `ended`; after that, fresh sessions only. */
export const RESUMED_WINDOW_MS = 30 * 60_000
export const OWNER_BUSY_LINE = "The owner is busy now; do not promise an immediate answer from them."

/** The layer text for one record, or undefined when it adds nothing. */
export function renderSituationLayer(row: SituationRow, opts: { fresh: boolean; ownerBusy?: boolean; now?: number; importance?: boolean; templates?: boolean; agentFill?: boolean }): string | undefined {
  if (!opts.fresh) {
    if (row.phase === "during") return undefined
    if ((opts.now ?? Date.now()) - row.phaseChangedAt > RESUMED_WINDOW_MS) return undefined
  }
  // Phase 6 (situations.templates): the template's title, the talk's
  // purpose (one line, quoted: a person or the agent wrote it) and the
  // phase's rule. Off: the line is exactly as before.
  const tpl = opts.templates ? situationTemplate(row.template) : null
  const purpose = tpl && oneLine(row.closing?.purpose, PURPOSE_MAX) ? quoted(row.closing!.purpose, PURPOSE_MAX) : ""
  const name = tpl ? `${tpl.title}${purpose ? ` (${purpose})` : ""}` : row.template.charAt(0).toUpperCase() + row.template.slice(1)
  const why = row.why ? row.why.replace(/\s+/g, " ").slice(0, WHY_MAX) : ""
  const byPerson = row.setBy === "person" ? " It was set by a person." : ""
  let line: string
  if (row.phase === "ending") {
    line = `[Situation] ${name}, phase: ending${why ? ` (${why})` : ""}.${byPerson} If a goodbye is due, say one short goodbye, then stop; do not open a new topic.`
  } else if (row.phase === "ended") {
    line = `[Situation] ${name}, phase: ended (${row.endReason ?? "closed"}).${row.setBy === "person" ? " It was set by a person." : ""} Answer only what this message needs, briefly.`
  } else {
    line = `[Situation] ${name}, phase: during.${row.override === "not-this" ? " A person said this talk is not ending." : ""}`
  }
  const rule = tpl?.rules[row.phase]
  if (rule) line += ` ${rule}`
  if (opts.templates && opts.agentFill && opts.fresh && row.phase === "during" && row.template === "conversation") line += ` ${AGENT_FILL_LINE}`
  if (opts.ownerBusy) line += ` ${OWNER_BUSY_LINE}`
  // Phase 5 (situations.importance): only a high importance is worth the
  // tokens. The reason is generic ("a client is in the talk"), never a name.
  if (opts.importance && row.importance === "high") line += ` This talk matters: ${(row.importanceWhy || "high importance").slice(0, WHY_MAX)}.`
  return line
}

/** Set to "1" in an agent process's environment while this node lets
 *  agents name their talk (phase 6); the agentx MCP server lists
 *  `agentx_situation` only then. A running process keeps the value it was
 *  started with. */
export const SITUATION_TOOL_ENV = "AGENTX_SITUATION_TOOL"

/** Do agents on this node name their talk (`agentx_situation`) now? */
export function situationToolOn(): boolean {
  try {
    const s = source?.settings()
    return !!s && s.mode !== "off" && s.templates?.enabled === true && s.templates.agentFill === true
  } catch { return false }
}

/** Set to "1" in an agent process's environment while a per-request
 *  source is switched on here (phase 7); the agentx MCP server lists
 *  `agentx_sources` only then. */
export const SOURCES_TOOL_ENV = "AGENTX_SOURCES_TOOL"

export const PER_REQUEST_SOURCE_IDS = ["open-apps", "browser-tabs", "news"] as const

/** Is any per-request source switched on in these settings? */
export function sourcesToolOn(sources: Record<string, { enabled?: boolean }> | undefined): boolean {
  // browser-tabs never loads without a separate reader (none yet), so it
  // alone does not list the tool.
  return PER_REQUEST_SOURCE_IDS.some((id) => id !== "browser-tabs" && sources?.[id]?.enabled === true)
}

/** Do agents on this node get `agentx_sources` now (phase 7)? Only while
 *  a per-request source is switched on. */
export function sourcesToolEnvOn(): boolean {
  try { return sourcesToolOn(source?.settings().sources) } catch { return false }
}

/** The layer for the chat whose record has this key. */
export function situationContextFor(key: string | undefined, opts: { fresh: boolean }): string | undefined {
  if (!key || !source) return undefined
  try {
    if (source.settings().mode !== "active") return undefined
    const row = source.store.get(key)
    if (!row) return undefined
    const now = Date.now()
    if (!opts.fresh && (row.phase === "during" || now - row.phaseChangedAt > RESUMED_WINDOW_MS)) return undefined
    let ownerBusy = false
    try {
      ownerBusy = (source.hold ?? readHold)().active === true
    } catch { /* unknown means not busy, as the hold reads it */ }
    const t = source.settings().templates
    return renderSituationLayer(row, {
      fresh: opts.fresh, ownerBusy, now, importance: source.settings().importance?.enabled === true,
      templates: t?.enabled === true, agentFill: t?.enabled === true && t.agentFill === true,
    })
  } catch {
    return undefined
  }
}
