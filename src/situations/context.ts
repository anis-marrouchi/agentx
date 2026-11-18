import { readHold } from "@/notify/hold"
import type { FocusState } from "@/notify/focus"
import type { SituationsConfig } from "./config"
import type { SituationRow, SituationStore } from "./store"

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
// which is the moment the line is for. It is one line, about 30 tokens.
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

/** The layer text for one record, or undefined when it adds nothing. */
export function renderSituationLayer(row: SituationRow, opts: { fresh: boolean; ownerBusy?: string }): string | undefined {
  if (!opts.fresh && row.phase === "during") return undefined
  const name = row.template.charAt(0).toUpperCase() + row.template.slice(1)
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
  if (opts.ownerBusy) line += ` The owner is busy (${opts.ownerBusy}).`
  return line
}

/** The layer for the chat whose record has this key. */
export function situationContextFor(key: string | undefined, opts: { fresh: boolean }): string | undefined {
  if (!key || !source) return undefined
  try {
    if (source.settings().mode !== "active") return undefined
    const row = source.store.get(key)
    if (!row) return undefined
    if (!opts.fresh && row.phase === "during") return undefined
    let ownerBusy: string | undefined
    try {
      const h = (source.hold ?? readHold)()
      if (h.active) ownerBusy = h.reason.slice(0, 60)
    } catch { /* unknown means not busy, as the hold reads it */ }
    return renderSituationLayer(row, { fresh: opts.fresh, ownerBusy })
  } catch {
    return undefined
  }
}
