import { forgeHomeOf } from "@/daemon/wall-forge-state"
import type { ForgeItem, ForgeReader } from "./checkers/issue"
import type { RequestRecord, RequestStore } from "./store"

// --- The home is the default check (#1522) ---
//
// An open request with no `closeWhen` whose home is a GitHub or GitLab
// issue, pull request or merge request (its home link, else the forge chat
// it was asked in, as the Wall reads it) has that home read at the
// checkers' pace. When the pull or merge request is merged, or the issue
// is closed as completed, the request closes as done, verified, with the
// home link and who closed it as its evidence. An active tracked plan ends
// with it; its steps left are kept, marked skipped. The owner is not told:
// the Wall shows it closed.
//
// Left alone: requests waiting on the owner (the question stays theirs),
// issues closed as not planned or duplicate, pull or merge requests closed
// without a merge, and homes that cannot be read.

/** How many homes one check reads, at once: the loop checkers' batch. */
const HOME_BATCH = 10

export interface HomeCloseDeps {
  store: RequestStore
  read: ForgeReader
  /** This node's GitLab address: GitLab homes need it. */
  gitlabUrl: string | null
  everyMinutes: number
  now: number
  /** Ends the request's active tracked plan, its steps left skipped. */
  endPlan?: (requestId: string, why: string, now: number) => void
  log: (msg: string) => void
}

/** "merged" or "closed" when the home says the work is finished; null
 *  when it does not. */
export function homeFinished(item: ForgeItem, mr: boolean): "merged" | "closed" | null {
  if (item.state === "merged") return "merged"
  if (item.state !== "closed" || mr || item.pullRequest) return null
  return item.stateReason === "not_planned" || item.stateReason === "duplicate" ? null : "closed"
}

/** The check's words: the home link, what happened, who and when. */
export function homeEvidence(item: ForgeItem, how: "merged" | "closed"): string {
  const at = item.closedAt ? Date.parse(item.closedAt) : NaN
  const when = Number.isFinite(at) ? ` on ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""
  return `${item.url} ${how}${item.closedBy ? ` by ${item.closedBy}` : ""}${when}`
}

export async function closeOnHome(deps: HomeCloseDeps): Promise<{ checked: number; closed: number }> {
  const { store, now, log } = deps
  const due = store.dueForHomeCheck(now - deps.everyMinutes * 60_000, HOME_BATCH)
  let checked = 0
  let closed = 0
  await Promise.all(due.map(async (r: RequestRecord) => {
    // Marked before the read: one that hangs is not read again next minute,
    // and one with no forge home waits its turn like the others.
    store.markHomeChecked(r.id, now)
    const home = forgeHomeOf({ home: r.home, group: { channel: r.channel, chatId: r.chatId } }, deps.gitlabUrl)
    if (!home) return
    checked++
    const item = await deps.read(home.provider, home.ref, { notes: false }).catch((e: any) => ({ error: String(e?.message ?? e) }))
    if ("error" in item) return
    const how = homeFinished(item, home.ref.mr)
    if (!how) return
    // Read again: it may have moved on to the owner while the forge answered.
    if (store.get(r.id)?.state === "waiting_owner") return
    const why = `home closed: ${home.key} ${how}${item.closedBy ? ` by ${item.closedBy}` : ""}`
    if (!store.closeVerified(r.id, homeEvidence(item, how), now, { unless: ["waiting_owner"] })) return
    closed++
    try { deps.endPlan?.(r.id, why, now) } catch (e: any) { log(`[requests] ${r.id}: its plan did not end: ${e?.message ?? e}`) }
    log(`[requests] ${r.id} closed: home ${home.key} ${how}${item.closedBy ? ` by ${item.closedBy}` : ""}`)
  }))
  return { checked, closed }
}
