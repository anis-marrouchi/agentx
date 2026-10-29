import type { RequestRecord, RequestStore } from "./store"
import { parseRef, type ForgeReader, type ParsedRef } from "./checkers/issue"

// --- The home closes the request (#1522) ---
//
// Agents name where the work lives (agentx_request home: an issue, a pull
// or merge request) far more often than they give a closeWhen, and the
// work often ends in another turn, another chat or after a restart, where
// nobody calls done. The Wall already read the home's live state and
// showed the mismatch (#1195), but nothing closed the request, so done
// work stayed open on the owner's list.
//
// The requests check reads the home of every open request that has no
// checker of its own, as often as the loop checkers run. A merged pull or
// merge request, or an issue closed as completed, closes the request as
// done, checked, with who closed it and when, once it closed after the
// request was asked and after the owner last sent it back. A tracked plan
// stops with it (plan-sweep): the steps it had left are named in the
// evidence. Left as they are: an open home, a pull or merge request closed
// without merging, an issue closed as not planned or a duplicate, a home
// that cannot be read or gives no close time, a home closed before the
// request was asked or sent back, a home on a forge host this node does not
// read, a link to a comment or note inside an item, a request whose active
// plan still has steps an agent owns (the plan, not the home, says when
// that work is done), and every request waiting on the owner
// (store.homesDue).

/** What reading a request's home said. */
export type HomeVerdict =
  | { verdict: "closed"; detail: string; closedAt: number }
  | { verdict: "open" | "unknown"; detail: string }

/** Reads a request's home. Null: it has no forge home this node reads. */
export type HomeChecker = (r: RequestRecord) => Promise<HomeVerdict | null>

export interface HomeRef { provider: "github" | "gitlab"; ref: ParsedRef; link: string }

/** The forge item a request's home link names. A GitLab address must be
 *  on this node's GitLab: another host would be read from ours. A short
 *  ref ("group/project#12") names no forge, so it is not read. */
export function homeRefOf(r: Pick<RequestRecord, "home">, gitlabUrl: string | null | undefined): HomeRef | null {
  if (r.home?.kind !== "issue") return null
  const link = r.home.link.trim()
  let host: string
  let url: URL
  try { url = new URL(link); host = url.host.toLowerCase() } catch { return null }
  // An anchor names a point inside the item (#issuecomment-…, #note_…), a
  // piece of work that lives there, not the item: its state is not the
  // work's (#1522, a slice homed on a comment of its parent issue).
  if (url.hash) return null
  if (host === "github.com") {
    const ref = parseRef("github", link)
    return ref ? { provider: "github", ref, link } : null
  }
  let ours: string | null = null
  try { ours = gitlabUrl ? new URL(gitlabUrl).host.toLowerCase() : null } catch { ours = null }
  if (!ours || host !== ours) return null
  const ref = parseRef("gitlab", link)
  return ref ? { provider: "gitlab", ref, link } : null
}

/** Why a GitHub issue closed that means the work was done. GitLab gives
 *  none, and an older GitHub item none either: closed is done. */
const DONE_REASONS = new Set(["completed"])

/** The daemon's home checker, over the configured forge connectors.
 *  `github`: this node reads GitHub with a token. Without one, GitHub's
 *  60 reads an hour would go to these checks and the Wall's own reads. */
export function homeChecker(read: () => { forge?: ForgeReader; gitlabUrl: string | null; github: boolean }): HomeChecker {
  return async (r) => {
    const { forge, gitlabUrl, github } = read()
    const home = homeRefOf(r, gitlabUrl)
    if (!home || !forge || (home.provider === "github" && !github)) return null
    const item = await forge(home.provider, home.ref, { notes: false })
    if ("error" in item) return { verdict: "unknown", detail: `${home.link}: ${item.error}` }
    const by = [item.closedBy ? `by ${item.closedBy}` : "", item.closedAt ? `at ${item.closedAt}` : ""].filter(Boolean).join(" ")
    const at = item.closedAt ? Date.parse(item.closedAt) : NaN
    const closed = (what: string): HomeVerdict => Number.isFinite(at)
      ? { verdict: "closed", detail: `home ${item.url} ${what}${by ? ` ${by}` : ""}`, closedAt: at }
      : { verdict: "unknown", detail: `home ${item.url} is ${what}, with no time it closed` }
    if (item.state === "merged") return closed("merged")
    if (item.state === "closed") {
      // A pull or merge request is done only when it merged.
      if (home.ref.mr) return { verdict: "open", detail: `home ${item.url} closed without merging` }
      if (item.stateReason && !DONE_REASONS.has(item.stateReason)) return { verdict: "open", detail: `home ${item.url} closed as ${item.stateReason.replace(/_/g, " ")}` }
      return closed("closed")
    }
    return { verdict: "open", detail: `home ${item.url} is open` }
  }
}

/** A step the request's active plan has not finished. `agent`: an agent
 *  does it and reports (any kind but a message the daemon sends). */
export interface PlanStepLeft { step: string; agent: boolean }

/** How many homes one check reads. */
const HOME_BATCH = 10

/** Read the home of every open request due for it. Closed after the
 *  request was asked (or last sent back) closes it as done with the
 *  forge's words, and the steps its plan had left; anything else only
 *  notes the time, so it is read again after `everyMinutes`. */
export async function checkHomes(
  store: RequestStore,
  check: HomeChecker,
  opts: { everyMinutes: number; now: number; log: (msg: string) => void; planLeft?: (requestId: string) => PlanStepLeft[] },
): Promise<{ checked: number; closed: number }> {
  const due = store.homesDue(opts.now - opts.everyMinutes * 60_000, HOME_BATCH)
  let closed = 0
  await Promise.all(due.map(async ({ request: r, since }) => {
    // Marked before the call: a read that hangs is not started again at
    // the next minute.
    store.markHomeChecked(r.id, opts.now)
    const res = await check(r).catch((e: any): HomeVerdict => ({ verdict: "unknown", detail: String(e?.message ?? e) }))
    if (res?.verdict !== "closed") return
    // Closed before it was asked, or before the owner sent it back: the
    // work it asks for is after that close.
    if (res.closedAt <= since) return
    const left = opts.planLeft?.(r.id) ?? []
    // An agent still owes a step: the home closing (a parent issue, an
    // early merge) is not that step done. Read again next interval.
    const agentLeft = left.filter((s) => s.agent).map((s) => s.step)
    if (agentLeft.length) {
      opts.log(`[requests] ${r.id} left open: ${res.detail}; home closed, plan has agent steps left: ${agentLeft.join("; ")}`)
      return
    }
    const detail = left.length ? `${res.detail}; its plan stopped with steps left: ${left.map((s) => s.step).join("; ")}` : res.detail
    if (store.closeVerified(r.id, detail, opts.now)) {
      closed++
      opts.log(`[requests] ${r.id} closed: ${detail}`)
    }
  }))
  return { checked: due.length, closed }
}
