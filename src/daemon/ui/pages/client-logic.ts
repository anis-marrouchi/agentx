// --- Pure logic of a client's page, "Your project" (/member for a client) (#453) ---
//
// Sent to the browser with injectFns (client.ts) and tested directly in
// test/client-page.test.ts. Each function stands alone: it is shipped as
// its own source, so it cannot call a sibling.
//
// A client is someone the owner does work for, not a teammate. The words
// are theirs: no agent ids, no "owner", no "turn". "Us" is the owner and
// their agents together; the client does not need to tell them apart.

/** How one of the client's turns reads on the page. The request the turn
 *  became speaks first: it knows when a person on the owner's side is asked. */
export function clientSentState(r: { status: string; request?: { state: string } | null }): { label: string; tone: string } {
  const req = r.request ? r.request.state : ""
  if (req === "waiting_owner" || req === "waiting_other") return { label: "Waiting on us", tone: "wait" }
  if (req === "needs_attention") return { label: "Needs a look from us", tone: "stuck" }
  if (r.status === "in-flight") return { label: "Being worked on", tone: "work" }
  if (r.status === "ok") return { label: "Finished", tone: "done" }
  if (r.status === "error" || r.status === "timeout") return { label: "Stopped, we will look at it", tone: "stuck" }
  if (r.status === "canceled" || r.status === "cancelled") return { label: "Stopped", tone: "off" }
  return { label: String(r.status || "").replace(/[_-]/g, " "), tone: "off" }
}

/** How a request no turn on the page stands for reads: its turn is older
 *  than the list, or it has none. */
export function clientRequestState(state: string): { label: string; tone: string } {
  if (state === "in_progress") return { label: "Being worked on", tone: "work" }
  if (state === "waiting_owner" || state === "waiting_other") return { label: "Waiting on us", tone: "wait" }
  if (state === "needs_attention") return { label: "Needs a look from us", tone: "stuck" }
  if (state === "done") return { label: "Finished", tone: "done" }
  if (state === "declined") return { label: "Not taken on", tone: "off" }
  if (state === "dropped") return { label: "Set aside", tone: "off" }
  return { label: String(state || "").replace(/_/g, " "), tone: "off" }
}

/** The one sentence at the top of the page, from the tone of every row
 *  shown: "work" is being worked on, "wait" waits on the owner's side,
 *  "stuck" needs a look, "done" finished. */
export function clientSummary(tones: string[]): string {
  if (!tones.length) return "Nothing asked for yet."
  // Counted in a loop, not with an inner named function: a bundler can wrap
  // one in a helper that is not shipped with this function's own source.
  let work = 0
  let wait = 0
  let stuck = 0
  let done = 0
  for (let i = 0; i < tones.length; i++) {
    if (tones[i] === "work") work++
    else if (tones[i] === "wait") wait++
    else if (tones[i] === "stuck") stuck++
    else if (tones[i] === "done") done++
  }
  const parts: string[] = []
  if (work) parts.push(work === 1 ? "1 request is being worked on for you." : work + " requests are being worked on for you.")
  if (wait) parts.push(wait === 1 ? "1 is waiting on us." : wait + " are waiting on us.")
  if (stuck) parts.push(stuck === 1 ? "1 needs a look from us." : stuck + " need a look from us.")
  if (!parts.length) return done ? "Nothing in progress right now. " + (done === 1 ? "1 request finished" : done + " requests finished") + " this week." : "Nothing in progress right now."
  return parts.join(" ")
}
