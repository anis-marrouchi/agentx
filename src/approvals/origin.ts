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

export type CardOrigin = ReminderOrigin | RequestOrigin

/** Lines for the owning agent's result message. */
export function originLines(origin: ReminderOrigin, approved: boolean): string[] {
  const where = origin.list ? ` in the "${origin.list}" list` : ""
  const lines = [`This card came from the operator's reminder "${origin.title}"${where} (id ${origin.id}).`]
  lines.push(approved
    ? `Do what the operator chose, then tick the reminder off: remindctl complete ${origin.id}`
    : "Leave the reminder open; it will come back at a later check-in.")
  return lines
}
