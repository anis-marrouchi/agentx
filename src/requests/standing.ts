import { RHYTHMS, type Rhythm } from "@/numbers/model"

// --- Standing orders (noqta#807, fleet rule R5) ---
//
// "Every day" or "every week" from the owner is not a request that ends
// when the first one is done: it is a recurring job with an owner, a
// rhythm and a number that proves it. A request marked standing:
//   - names the number (src/numbers) that proves each period, and the
//     cron that runs it when there is one;
//   - is never closed by its agent, a check, a plan or the settle pass:
//     only the owner ends it (store.close with OWNER_BY).
// Finding "every day" in the owner's words on its own is slice 2.

export interface StandingOrder {
  rhythm: Rhythm
  /** The number that proves it, per period (`agentx numbers show <id>`). */
  numberId: string
  /** The cron that runs it, when it has one. */
  cronId: string | null
  /** When it was marked standing, epoch ms. */
  since: number
}

/** What a number must give for a standing order: only what is read here. */
export interface StandingNumbers {
  get(id: string): { rhythm: Rhythm; archivedAt: number | null } | null
}

const CRON_ID_RE = /^[\w.:-]{1,120}$/
const NUMBER_ID_RE = /^[\w.:-]{1,80}$/

/** The refusal an agent gets when it tries to end a standing order. */
export function standingRefusal(s: StandingOrder): string {
  return `Not closed: this is a standing order (${s.rhythm}), and only the owner ends it. ` +
    `Report this period's number instead (agentx_numbers record, number "${s.numberId}"), and keep it open.`
}

/** The order from the tool's input, or why not. With `numbers`, the number
 *  must exist and be tracked, and its rhythm is the order's. */
export function parseStanding(input: Record<string, unknown>, numbers: StandingNumbers | null, now: number): StandingOrder | string {
  const numberId = typeof input.number === "string" ? input.number.trim() : ""
  if (!NUMBER_ID_RE.test(numberId)) return "standing needs number: the id of the number that proves each period (agentx_numbers lists them; create one first)"
  const cronRaw = typeof input.cron === "string" ? input.cron.trim() : ""
  if (cronRaw && !CRON_ID_RE.test(cronRaw)) return "cron: the id of the cron that runs it (letters, digits, . : _ -)"
  const asked = typeof input.rhythm === "string" ? input.rhythm.trim().toLowerCase() : ""
  if (asked && !(RHYTHMS as readonly string[]).includes(asked)) return `rhythm: one of ${RHYTHMS.join(", ")}`
  let rhythm = asked as Rhythm | ""
  if (numbers) {
    const n = numbers.get(numberId)
    if (!n || n.archivedAt !== null) return `no tracked number "${numberId}": create it with agentx_numbers first`
    if (rhythm && rhythm !== n.rhythm) return `rhythm ${rhythm} is not the number's (${n.rhythm}): the number's rhythm is the order's`
    rhythm = n.rhythm
  }
  if (!rhythm) return `standing needs rhythm: one of ${RHYTHMS.join(", ")}`
  return { rhythm, numberId, cronId: cronRaw || null, since: now }
}

/** A stored order, or null when there is none or it does not read. */
export function readStanding(raw: unknown): StandingOrder | null {
  if (typeof raw !== "string" || !raw) return null
  try {
    const s = JSON.parse(raw)
    return s && (RHYTHMS as readonly string[]).includes(s.rhythm) && typeof s.numberId === "string" && typeof s.since === "number"
      ? { rhythm: s.rhythm, numberId: s.numberId, cronId: typeof s.cronId === "string" ? s.cronId : null, since: s.since }
      : null
  } catch {
    return null
  }
}
