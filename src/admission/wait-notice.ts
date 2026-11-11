// --- Written lines for a person whose message waits or cannot start ---
//
// A chat message that waits in the admission queue gets one short line
// after a while (admission.waitNotice), so the person who asked sees that
// it arrived. The same wording family covers the two ways such a run can
// end without starting: refused after admission.maxWaitMinutes, and held
// by the plan limit (dispatch_hold).
//
// These lines are posted where everyone on the thread can read them (a
// GitLab note is a top-level note on the issue), so they carry no
// numbers from the machine, no host names and no client detail: only a
// plain reason. The full reason stays in the daemon log.

/** The plain reason a run is waiting, from the queue's blockedBy list.
 *  The machine's own limits come first: they are what the person waits on. */
export function plainWaitReason(blockedBy: string[]): string {
  const has = (prefix: string) => blockedBy.some((b) => b.startsWith(prefix))
  if (has("disk:")) return "the machine that runs me is short of free disk space"
  if (has("memory:") || has("swap:")) return "the machine that runs me is short of free memory"
  if (has("load:")) return "the machine that runs me is very busy"
  if (has("session cap") || has("start pace") || has("behind earlier work") || has("class ")) {
    return "other work is ahead of it on the machine that runs me"
  }
  if (has("agent busy")) return "I am working on another request"
  return "the machine that runs me has no room yet"
}

/** The one line posted after a run has waited admission.waitNotice.afterSeconds. */
export function waitNoticeText(blockedBy: string[]): string {
  return `Received. I have not started yet because ${plainWaitReason(blockedBy)}. ` +
    `Your request is in the queue and starts on its own when there is room; I will answer here. ` +
    `If it cannot start after a long wait, I will say so here.`
}

/** The line for a run refused after admission.maxWaitMinutes. It follows
 *  the wait line above without contradicting it: that line said a refusal
 *  would be announced here. */
export function waitRefusalText(blockedBy: string[]): string {
  return `I could not start this request: ${plainWaitReason(blockedBy)}, and that lasted too long. ` +
    `It is no longer in the queue. Please send it again.`
}

/** "HH:MM UTC", rounded up to the next whole minute so "after" stays true. */
export function utcClock(ms: number): string {
  const d = new Date(Math.ceil(ms / 60_000) * 60_000)
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`
}

/** The line for a run held by the plan limit. Nothing is kept: the run is
 *  refused, so the line asks for the message again, after a time when known. */
export function planHoldText(retryAt?: number): string {
  const when = retryAt ? `after ${utcClock(retryAt)}` : "later"
  return `Received, but I cannot start new work right now: the AI plan limit is reached. ` +
    `It is not queued. Please send it again ${when}.`
}
