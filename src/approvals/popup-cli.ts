import type { DecisionCard } from "./cards"
import type { PopupAnswer } from "./popup"

// --- `agentx approvals popup <key>` from a terminal (#1788) ---
//
// The command opens the card on the Mac screen. Run by an agent only to
// read a card, the window still took a click from whoever sat at the Mac
// and recorded it as the operator's answer. So:
//   - inside an agent's run (AGENTX_AGENT_ID set) it never records: it
//     prints the card in the terminal, or with --dry-run shows the window
//     and records nothing;
//   - --print prints the card and opens nothing, for anyone;
//   - every run writes the same kind of line the daemon's popup writes,
//     naming who ran it, so the answer can be traced afterwards.

export type PopupCliMode = "sample" | "print" | "show" | "record"

export interface PopupCliOptions {
  sample?: boolean
  print?: boolean
  dryRun?: boolean
}

/** What the command does, and the agent whose run called it (if any). */
export function popupCliMode(opts: PopupCliOptions, env: NodeJS.ProcessEnv = process.env): { mode: PopupCliMode; agent?: string } {
  const agent = env.AGENTX_AGENT_ID?.trim() || undefined
  if (opts.sample) return { mode: "sample", agent }
  if (opts.print) return { mode: "print", agent }
  if (opts.dryRun) return { mode: "show", agent }
  return { mode: agent ? "print" : "record", agent }
}

/** Who ran it, for the log line and the card's decided_by. */
export function popupCaller(agent: string | undefined): string {
  return agent ? `agent ${agent} (terminal)` : "operator (terminal)"
}

/** The card as plain text, for --print. */
export function cardAsText(card: DecisionCard): string {
  const lines = [`${card.title}`, `  from ${card.raised_by}, waiting until ${card.expires}`, `  ${card.ask}`]
  if (card.context) lines.push(`  context: ${card.context.replace(/\n/g, " ")}`)
  ;(card.choices ?? []).forEach((c, i) => lines.push(`  ${i + 1}. ${c}`))
  lines.push(`  recommends: ${card.recommend}`)
  if (card.draft) lines.push("  draft:", ...card.draft.split("\n").map((l) => `    ${l}`))
  if (card.source) lines.push(`  source: ${card.source}`)
  return lines.join("\n")
}

/** One log line per step, in the daemon popup's words. */
export function popupLogLine(key: string, caller: string, event: "showing" | "printed" | PopupAnswer | { recorded: string } | { notRecorded: string }): string {
  const head = `[approvals] popup (${caller}):`
  if (event === "showing") return `${head} showing ${key}`
  if (event === "printed") return `${head} printed ${key}; nothing shown, nothing recorded`
  if ("recorded" in event) return `${head} ${event.recorded}`
  if ("notRecorded" in event) return `${head} ${key} not recorded: ${event.notRecorded}`
  if (event.action === "dismiss") return `${head} ${key} left waiting: ${event.why ?? "no answer"}`
  return `${head} ${key} answered ${event.action}${event.action === "yes" && event.choice ? ` (${event.choice})` : ""}`
}
