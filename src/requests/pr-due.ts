import { parseRef } from "./checkers/issue"
import { when } from "./loops"
import { workHint } from "./work-hint.js"
import type { LinkKind, RequestRecord } from "./store"

// --- A missed PR due time (#2279) ---
//
// A promise whose words say a pull or merge request is due (a "Draft PR
// by 17:00Z") and that falls due with no PR linked: the requests check
// wakes its agent at once, with the issue, and the lead (`promises.prLead`,
// Hakim by default) 15 min later if there is still none. Both run in the
// requests check's due-promise push (sweep.ts), once per due time.
//
// What counts, from what the record already has (nothing is read from a
// forge here):
//   a PR due     its headline or words name one: "PR", "MR", "pull
//                request", "merge request" (any case for the long forms)
//   a PR linked  any of its own records names a pull or merge request: its
//                home, a link (an issue link may be one), its checker's ref,
//                its words, its evidence, its proof or a deliverable proof.
//                A PR named anywhere means it exists, so nothing wakes.

/** How long after the agent was woken the lead is woken (#2279). */
export const PR_LEAD_AFTER_MS = 15 * 60_000
/** A push older than this is not followed up: the lead hears of a fresh
 *  miss, not of every PR promise pushed before this check existed. */
export const PR_LEAD_WINDOW_MS = 60 * 60_000

/** "pr" or "mr" in lower case is rarely a PR; the long forms are read in
 *  any case. */
const PR_SHORT = /\b(?:PRs?|MRs?)\b/
const PR_LONG = /\b(?:pull|merge)[ -]requests?\b/i
/** A pull or merge request address, or a GitLab "group/project!12". */
const PR_LINK = /https?:\/\/[^\s<>()"'`]+?\/(?:-\/merge_requests|pull)\/\d+(?!\d)/
const MR_REF = /(?<![\w/.:@-])[\w-][\w.-]*(?:\/[\w-][\w.-]*)+!\d+(?!\w)/
const ISSUE_LINK = /https?:\/\/[^\s<>()"'`]+?\/(?:-\/)?issues\/\d+(?!\d)/

/** Its words say a pull or merge request is due. */
export function namesPrDue(r: Pick<RequestRecord, "headline" | "text">): boolean {
  const words = `${r.headline ?? ""}\n${r.text}`
  return PR_SHORT.test(words) || PR_LONG.test(words)
}

const isPrRef = (s: string | null | undefined): boolean => {
  if (!s) return false
  if (PR_LINK.test(s) || MR_REF.test(s)) return true
  const ref = s.trim()
  return !!(parseRef("github", ref)?.mr || parseRef("gitlab", ref)?.mr)
}

/** A pull or merge request is linked to it already. */
export function prLinked(r: RequestRecord, links: ReadonlyArray<{ kind: LinkKind; ref: string }>): boolean {
  if (r.home && isPrRef(r.home.link)) return true
  if (links.some((l) => isPrRef(l.ref))) return true
  if (r.closeWhen?.kind === "issue" && parseRef(r.closeWhen.provider, r.closeWhen.ref)?.mr) return true
  if (isPrRef(r.text) || isPrRef(r.headline) || isPrRef(r.evidence) || isPrRef(r.proof?.value)) return true
  return (r.deliverableProofs ?? []).some((p) => isPrRef(p.link))
}

/** A PR is due on it and none is linked: the one test both wakes use. */
export function missedPr(r: RequestRecord, links: ReadonlyArray<{ kind: LinkKind; ref: string }>): boolean {
  return r.promise && r.dueAt !== null && namesPrDue(r) && !prLinked(r, links)
}

/** The issue the PR is for, as a link when one can be written: its
 *  checker's issue, its home, an issue address in its words, or its forge
 *  chat. Null when none is named. */
export function issueOf(r: RequestRecord): string | null {
  const cw = r.closeWhen
  if (cw?.kind === "issue") {
    const ref = parseRef(cw.provider, cw.ref)
    if (ref && !ref.mr) {
      if (/^https?:\/\//i.test(cw.ref)) return cw.ref
      return cw.provider === "github" ? `https://github.com/${ref.project}/issues/${ref.number}` : cw.ref
    }
  }
  if (r.home?.kind === "issue" && !isPrRef(r.home.link)) return r.home.link
  const inWords = `${r.headline ?? ""}\n${r.text}`.match(ISSUE_LINK)
  if (inWords) return inWords[0].replace(/[.,;:]+$/, "")
  const chat = r.chatId.match(/^(.+?):issue:(\d+)$/)
  if (chat && r.channel === "github") return `https://github.com/${chat[1]}/issues/${chat[2]}`
  if (chat && r.channel === "gitlab") return `${chat[1]}#${chat[2]}`
  return null
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const wordsOf = (r: RequestRecord) => clip((r.headline ?? r.text).replace(/\s+/g, " ").trim(), 300)

/** What the agent reads when its PR due time passed with no PR linked. */
export function prDueText(r: RequestRecord, lead: string | null): string {
  const issue = issueOf(r)
  return `[agentx:pr-due id=${r.id}] Your PR was due ${when(r.dueAt!)} and no PR is linked${issue ? `. Issue: ${issue}` : ""}. You promised: ${wordsOf(r)}. ` +
    `Open the PR now and close this with agentx_request {action:"done", id:"${r.id}"${workHint(r)}, evidence:"<PR link>"}, or give a new due time with {action:"accept", id:"${r.id}"${workHint(r)}, due:"<ISO time>"} and the reason.` +
    (lead ? ` If no PR is linked in ${PR_LEAD_AFTER_MS / 60_000} min, ${lead} is woken.` : "")
}

/** What the lead reads 15 min after the agent was woken, still no PR.
 *  `woken` false: nothing could wake the agent then (#2291 C1). */
export function prLeadText(r: RequestRecord, pushedAt: number, woken = true): string {
  const issue = issueOf(r)
  return `[agentx:pr-due-lead id=${r.id}] ${r.agentId} set ${when(r.dueAt!)} for a PR and none is linked${issue ? `. Issue: ${issue}` : ""}. ` +
    `${r.agentId} ${woken ? "was woken" : "could not be woken (a run was on it, or it is not on this node)"} at ${when(pushedAt)} and ${Math.round(PR_LEAD_AFTER_MS / 60_000)} min later there is still no PR. It promised: ${wordsOf(r)}. ` +
    `Find out from ${r.agentId} what holds it, then hand it on, set a new due time with \`agentx requests due ${r.id} <ISO time>\`, or drop it.`
}
