import { checkProofLink, type ProofLinkContext, type ProofLinkResult } from "./proof-link"

// --- Proof links checked when a request or promise closes (#2122 PR 2) ---
//
// The links a close names (its link proof, the per-deliverable proofs, a
// hand-back's link) are opened with checkProofLink: at most `maxLinks` of
// them, all at once, with one time limit on the whole check, so a close
// with many proofs cannot take minutes (review C3).
//
// off: nothing is opened. warn: the result is recorded on the request and
// the closing agent is told; the close goes through. block: as warn, and a
// close is refused only on a firm failure (a wrong forge state or sha, a
// 404 or 410 page; review C2). Unverifiable never refuses.

export type ProofCheckMode = "off" | "warn" | "block"

export interface ProofCheckSettings {
  mode: ProofCheckMode
  /** Links opened per close. The rest are named as not checked. */
  maxLinks: number
  /** One time limit on the whole check, in ms. */
  totalTimeoutMs: number
}

export const DEFAULT_PROOF_CHECK: ProofCheckSettings = { mode: "off", maxLinks: 10, totalTimeoutMs: 20_000 }

export interface ProofCheckOutcome {
  /** What the close records: verified only when every link was opened
   *  and showed it. */
  verify: { state: "verified" | "unverified"; detail: string }
  /** Block mode's reason to refuse: the first firm failure. Null in warn
   *  mode, or when no link failed firmly. */
  refuse: string | null
  results: Array<{ link: string; result: ProofLinkResult }>
}

/** Checks the links of one close. Unset when the mode is off. */
export type ProofChecker = (links: string[], claim: string) => Promise<ProofCheckOutcome | null>

const DETAIL_MAX = 600

export async function checkProofLinks(
  links: string[],
  claim: string,
  ctx: ProofLinkContext,
  settings: ProofCheckSettings,
  check: typeof checkProofLink = checkProofLink,
): Promise<ProofCheckOutcome | null> {
  const unique = [...new Set(links.map((l) => (l ?? "").trim()).filter(Boolean))]
  if (!unique.length) return null
  const max = Math.max(1, settings.maxLinks)
  const opened = unique.slice(0, max)
  const over = unique.length - opened.length

  let timer: ReturnType<typeof setTimeout> | undefined
  const outOfTime = new Promise<ProofLinkResult>((resolve) => {
    timer = setTimeout(() => resolve({ state: "unverifiable", detail: `the link check ran out of time (${Math.round(settings.totalTimeoutMs / 1000)} s in all)` }), settings.totalTimeoutMs)
  })
  let results: Array<{ link: string; result: ProofLinkResult }>
  try {
    results = await Promise.all(opened.map(async (link) => ({
      link,
      result: await Promise.race([
        check(link, claim, ctx).catch((e: any): ProofLinkResult => ({ state: "unverifiable", detail: `the link check failed: ${String(e?.message ?? e).slice(0, 200)}` })),
        outOfTime,
      ]),
    })))
  } finally {
    clearTimeout(timer)
  }

  const firm = results.find((r) => r.result.firm)
  const refuse = settings.mode === "block" && firm ? firm.result.detail : null
  const allVerified = over === 0 && results.every((r) => r.result.state === "verified")
  const said = results.map((r) => r.result.state === "verified" ? r.result.detail : `${r.result.state === "failed" ? "did not check out" : "not checked"}: ${r.result.detail}`)
  if (over > 0) said.push(`${over} more link${over === 1 ? "" : "s"} not checked (limit ${max} per close)`)
  const detail = `${allVerified ? "Link checked" : "Link not verified"}: ${said.join("; ")}`.slice(0, DETAIL_MAX)
  return { verify: { state: allVerified ? "verified" : "unverified", detail }, refuse, results }
}

/** The checker a daemon hands to the close paths, or undefined when off. */
export function proofChecker(settings: Partial<ProofCheckSettings> | undefined, ctx: () => ProofLinkContext): ProofChecker | undefined {
  const s = { ...DEFAULT_PROOF_CHECK, ...settings }
  if (s.mode === "off") return undefined
  return (links, claim) => checkProofLinks(links, claim, ctx(), s)
}
