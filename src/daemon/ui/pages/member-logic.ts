// --- Pure logic of a teammate's work page (/member) (#489) ---
//
// Sent to the browser with injectFns (member.ts) and tested directly in
// test/member-page.test.ts. Each function stands alone: it is shipped as
// its own source, so it cannot call a sibling.

/** What the strip under the title says, or null when the last load
 *  worked, whatever the browser says about its network (#496). "Offline"
 *  only when the browser itself has no network; a load that fails with
 *  the network up is the server not answering. `loaded`: the lists were
 *  filled at least once, so there is something to show. */
export function connectionNote(failed: boolean, browserOnline: boolean, retrySeconds: number, loaded: boolean): { text: string; retry: boolean } | null {
  if (!failed) return null
  if (!browserOnline) return { text: "Offline. Showing what was last loaded; live state needs a connection.", retry: false }
  return { text: "Can't reach the server. " + (loaded ? "Showing what was last loaded. " : "") + "Trying again every " + retrySeconds + " seconds.", retry: true }
}

/** A message preview as one plain sentence: markdown marks removed, line
 *  breaks folded. A preview is the first 200 characters of the message, so
 *  a mark can be cut in half. Underscores are left alone: in a team's
 *  messages they are far more often part of a name than emphasis. */
export function plainPreview(text: string | null | undefined): string {
  return String(text == null ? "" : text)
    .replace(/```[\w-]*|`/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|>+|[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/\*\*|~~/g, "")
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=[\s).,;:!?]|$)/gm, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
}

/** What an agent's card says (#443), from an AgentCard of /api/member/work.
 *  The state is always a word as well as a colour and a shape. Of a turn
 *  someone else started there is no text to show, only that it is theirs. */
export function agentLine(a: { state: string; by: string | null; text: string | null }): { label: string; tone: string; what: string | null; by: string | null; hint: string } {
  const by = a.by === "you" ? "you" : a.by === "owner" ? "the owner" : a.by ? "someone else" : null
  if (a.state === "working") {
    if (a.by === "you") return { label: "Working", tone: "work", what: a.text, by, hint: "Busy. A new message waits in line until this ends." }
    return { label: "Working", tone: "work", what: "Busy with someone else's task", by, hint: "A message you send now waits in line until this ends." }
  }
  if (a.state === "blocked") return { label: "Blocked", tone: "stuck", what: a.text ? "Stopped on: " + a.text : null, by, hint: "It stopped before finishing. It needs a person." }
  return { label: "Free", tone: "free", what: a.by === "you" && a.text ? "Finished: " + a.text : null, by: a.by === "you" ? by : null, hint: "Free. Ready for your next message." }
}

/** How one of the person's turns reads in "What you sent" (#443). A
 *  request the turn became speaks first: it knows when the owner is asked. */
export function sentState(r: { status: string; request?: { state: string } | null }): { label: string; tone: string } {
  const req = r.request ? r.request.state : ""
  if (req === "waiting_owner") return { label: "Waiting on the owner", tone: "wait" }
  if (req === "waiting_other") return { label: "Waiting on another agent", tone: "wait" }
  if (req === "needs_attention") return { label: "Stuck", tone: "stuck" }
  if (r.status === "in-flight") return { label: "Running", tone: "work" }
  if (r.status === "ok") return { label: "Finished", tone: "done" }
  if (r.status === "error" || r.status === "timeout") return { label: "Stopped", tone: "stuck" }
  if (r.status === "canceled" || r.status === "cancelled") return { label: "Stopped", tone: "off" }
  return { label: String(r.status || "").replace(/[_-]/g, " "), tone: "off" }
}

/** How a request no turn in "What you sent" stands for reads there (#443):
 *  its turn is older than the list, or it has none. */
export function requestState(state: string): { label: string; tone: string } {
  if (state === "in_progress") return { label: "In progress", tone: "work" }
  if (state === "waiting_owner") return { label: "Waiting on the owner", tone: "wait" }
  if (state === "waiting_other") return { label: "Waiting on another agent", tone: "wait" }
  if (state === "needs_attention") return { label: "Stuck", tone: "stuck" }
  if (state === "done") return { label: "Finished", tone: "done" }
  if (state === "declined") return { label: "Declined", tone: "off" }
  if (state === "dropped") return { label: "Dropped", tone: "off" }
  return { label: String(state || "").replace(/_/g, " "), tone: "off" }
}

/** The one sentence at the top of the work page (#443). */
export function summaryLine(agents: Array<{ agentId: string; state: string; by: string | null }>, sent: number): string {
  if (!agents.length && !sent) return "Nothing sent yet."
  const parts = agents.slice(0, 4).map(function (a) {
    if (a.state === "working") return a.agentId + (a.by === "you" ? " is working on your task." : " is busy with someone else's task.")
    if (a.state === "blocked") return a.agentId + " stopped on your task."
    return a.agentId + " is free."
  })
  if (agents.length > 4) parts.push((agents.length - 4) + " more below.")
  return parts.join(" ") || "Nothing running now."
}

/** The agents that went from Working to Free between two good loads
 *  (#443): the page tells the person with a notification, as well as the
 *  green card. `before` is null on the first load, which tells nothing. */
export function freedAgents(before: Array<{ agentId: string; state: string }> | null | undefined, after: Array<{ agentId: string; state: string }>): string[] {
  if (!before) return []
  const was: Record<string, string> = {}
  before.forEach(function (a) { was[a.agentId] = a.state })
  return after.filter(function (a) { return a.state === "free" && was[a.agentId] === "working" }).map(function (a) { return a.agentId })
}
