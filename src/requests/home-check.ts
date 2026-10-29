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
// done, checked, with who closed it and when. Its tracked plan stops with
// it (plan-sweep). Left as they are: an open home, an issue closed as not
// planned, a home that cannot be read, a home on a forge this node has no
// connector for, and every request waiting on the owner (store.homesDue).

/** What reading a request's home said. */
export type HomeVerdict =
  | { verdict: "closed"; detail: string }
  | { verdict: "open" | "unknown"; detail: string }

/** Reads a request's home. Null: it has no forge home this node reads. */
export type HomeChecker = (r: RequestRecord) => Promise<HomeVerdict | null>

export interface HomeRef { provider: "github" | "gitlab"; ref: ParsedRef; link: string }

/** The forge item a request's home link names. A GitLab address must be
 *  on this node's GitLab: another host would be read from ours. */
export function homeRefOf(r: Pick<RequestRecord, "home">, gitlabUrl: string | null | undefined): HomeRef | null {
  if (r.home?.kind !== "issue") return null
  const link = r.home.link.trim()
  let host: string
  try { host = new URL(link).host.toLowerCase() } catch { return null }
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

/** The daemon's home checker, over the configured forge connectors. */
export function homeChecker(read: () => { forge?: ForgeReader; gitlabUrl: string | null }): HomeChecker {
  return async (r) => {
    const { forge, gitlabUrl } = read()
    const home = homeRefOf(r, gitlabUrl)
    if (!home || !forge) return null
    const item = await forge(home.provider, home.ref, { notes: false })
    if ("error" in item) return { verdict: "unknown", detail: `${home.link}: ${item.error}` }
    const by = [item.closedBy ? `by ${item.closedBy}` : "", item.closedAt ? `at ${item.closedAt}` : ""].filter(Boolean).join(" ")
    if (item.state === "merged") return { verdict: "closed", detail: `home ${item.url} merged${by ? ` ${by}` : ""}` }
    if (item.state === "closed") {
      if (item.stateReason === "not_planned") return { verdict: "open", detail: `home ${item.url} closed as not planned` }
      return { verdict: "closed", detail: `home ${item.url} closed${by ? ` ${by}` : ""}` }
    }
    return { verdict: "open", detail: `home ${item.url} is open` }
  }
}

/** How many homes one check reads. */
const HOME_BATCH = 10

/** Read the home of every open request due for it. Closed closes the
 *  request as done with the forge's words; anything else only notes the
 *  time, so it is read again after `everyMinutes`. */
export async function checkHomes(
  store: RequestStore,
  check: HomeChecker,
  opts: { everyMinutes: number; now: number; log: (msg: string) => void },
): Promise<{ checked: number; closed: number }> {
  const due = store.homesDue(opts.now - opts.everyMinutes * 60_000, HOME_BATCH)
  let closed = 0
  await Promise.all(due.map(async (r) => {
    // Marked before the call: a read that hangs is not started again at
    // the next minute.
    store.markHomeChecked(r.id, opts.now)
    const res = await check(r).catch((e: any): HomeVerdict => ({ verdict: "unknown", detail: String(e?.message ?? e) }))
    if (res?.verdict !== "closed") return
    if (store.closeVerified(r.id, res.detail, opts.now)) {
      closed++
      opts.log(`[requests] ${r.id} closed: ${res.detail}`)
    }
  }))
  return { checked: due.length, closed }
}
