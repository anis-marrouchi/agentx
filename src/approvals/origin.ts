// --- Where a card came from, when the daemon raised it ---
//
// Agents raise most cards themselves. A check-in (checkin.ts) raises one on
// an agent's behalf for an open Apple Reminder, and records the reminder
// here so the agent that gets the answer knows what to act on and what to
// tick off. Only the daemon sets it: POST /approvals and the agent tool
// never pass it through.

export interface ReminderOrigin {
  kind: "reminder"
  /** The reminder's full id, as remindctl prints it. */
  id: string
  title: string
  list?: string
}

/** An open request that needs attention, shown as a card on the Mac
 *  (popup-runner.ts). Never stored: the request is the record. */
export interface RequestOrigin {
  kind: "request"
  id: string
}

/** A retro card (src/retro): fixes to the agents' environment proposed
 *  from one run that struggled. The answer goes back to the agent that ran
 *  it, which builds the picked fix for a second review. */
export interface RetroOrigin {
  kind: "retro"
  /** The run the retro read. */
  taskId: string
  /** Failure signature (wiki/failure-candidates.ts), for one card per signature. */
  signature: string
}

export type CardOrigin = ReminderOrigin | RequestOrigin | RetroOrigin

/** Lines for the agent told the result of a retro card. */
export function retroLines(origin: RetroOrigin, approved: boolean, choice: string | undefined): string[] {
  const lines = [`This was a retro card about run ${origin.taskId} (\`agentx trace show ${origin.taskId}\`).`]
  if (!approved || !choice || choice === RETRO_NONE) {
    lines.push("Change nothing. Do not propose these fixes again on your own.")
    return lines
  }
  lines.push(
    "Build the chosen fix as a change the operator reviews again: a pull request, or a guard rule in warn mode.",
    "Do not apply it to a live system directly. Tag what you add with `retro:" + origin.taskId + "` so it can be found and removed later.",
  )
  return lines
}

/** The last choice on every retro card. */
export const RETRO_NONE = "None of these"

/** Lines for the owning agent's result message. */
export function originLines(origin: ReminderOrigin, approved: boolean): string[] {
  const where = origin.list ? ` in the "${origin.list}" list` : ""
  const lines = [`This card came from the operator's reminder "${origin.title}"${where} (id ${origin.id}).`]
  lines.push(approved
    ? `Do what the operator chose, then tick the reminder off: remindctl complete ${origin.id}`
    : "Leave the reminder open; it will come back at a later check-in.")
  return lines
}
